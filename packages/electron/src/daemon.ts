import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { resolve } from "node:path";

export type DaemonState = "stopped" | "starting" | "running" | "error";

export type DaemonOptions = {
  nodePath: string;
  daemonScript: string;
  port: number;
  voluteHome: string;
  binDir: string;
  nodeModulesDir: string;
  onStateChange?: (state: DaemonState) => void;
  onLog?: (line: string) => void;
};

const HEALTH_POLL_INTERVAL = 500;
const HEALTH_TIMEOUT = 30_000;
const RESTART_DELAY = 3_000;

export class DaemonProcess {
  private child: ChildProcess | null = null;
  private state: DaemonState = "stopped";
  private opts: DaemonOptions;
  private quitting = false;
  private token = randomBytes(32).toString("hex");
  private restartAttempts = 0;
  private static MAX_RESTART_ATTEMPTS = 5;

  constructor(opts: DaemonOptions) {
    this.opts = opts;
  }

  getToken(): string {
    return this.token;
  }

  getState(): DaemonState {
    return this.state;
  }

  getPort(): number {
    return this.opts.port;
  }

  async start(): Promise<void> {
    if (this.child) return;

    // Check if port is already in use by a running daemon
    const reused = await this.tryReuseExisting();
    if (reused) return;

    await this.spawn();
  }

  private async tryReuseExisting(): Promise<boolean> {
    try {
      const res = await fetch(`http://127.0.0.1:${this.opts.port}/api/health`);
      if (res.ok) {
        // Read the token from the running daemon's config file
        const daemonJsonPath = resolve(this.opts.voluteHome, "system", "daemon.json");
        if (existsSync(daemonJsonPath)) {
          try {
            const config = JSON.parse(readFileSync(daemonJsonPath, "utf-8"));
            if (config.token) {
              this.token = config.token;
            } else {
              this.opts.onLog?.(`Warning: daemon.json has no token — API calls will fail`);
            }
          } catch (err) {
            this.opts.onLog?.(
              `Warning: could not read daemon token from ${daemonJsonPath}: ${err}. API calls will fail.`,
            );
          }
        } else {
          this.opts.onLog?.(`Warning: ${daemonJsonPath} not found — API calls will fail`);
        }
        this.setState("running");
        return true;
      }
    } catch {
      // Port not in use — good
    }
    return false;
  }

  private async spawn(): Promise<void> {
    this.setState("starting");

    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      VOLUTE_HOME: this.opts.voluteHome,
      VOLUTE_NODE_PATH: this.opts.nodePath,
      VOLUTE_DAEMON_TOKEN: this.token,
      PATH: `${this.opts.binDir}:${process.env.PATH ?? ""}`,
      NODE_PATH: this.opts.nodeModulesDir,
    };

    this.child = spawn(
      this.opts.nodePath,
      [this.opts.daemonScript, "--port", String(this.opts.port), "--foreground"],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env,
      },
    );

    this.child.on("error", (err) => {
      this.opts.onLog?.(`Daemon failed to spawn: ${err.message}`);
      this.child = null;
      this.setState("error");
    });

    this.child.stdout?.on("data", (data: Buffer) => {
      this.opts.onLog?.(data.toString());
    });
    this.child.stderr?.on("data", (data: Buffer) => {
      this.opts.onLog?.(data.toString());
    });

    this.child.on("exit", (code) => {
      this.child = null;
      if (this.quitting) {
        this.setState("stopped");
        return;
      }
      this.restartAttempts++;
      if (this.restartAttempts > DaemonProcess.MAX_RESTART_ATTEMPTS) {
        this.opts.onLog?.(
          `Daemon has crashed ${this.restartAttempts} times, giving up. Restart the app to try again.`,
        );
        this.setState("error");
        return;
      }
      const delay = RESTART_DELAY * 2 ** (this.restartAttempts - 1);
      this.opts.onLog?.(
        `Daemon exited with code ${code}, restart attempt ${this.restartAttempts}/${DaemonProcess.MAX_RESTART_ATTEMPTS} in ${delay}ms...`,
      );
      this.setState("error");
      setTimeout(() => {
        if (!this.quitting) {
          this.spawn().catch((err) => {
            this.opts.onLog?.(`Failed to restart daemon: ${err}`);
          });
        }
      }, delay);
    });

    await this.waitForHealth();
  }

  private async waitForHealth(): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < HEALTH_TIMEOUT) {
      if (!this.child) {
        throw new Error("Daemon process exited during startup — check logs for details");
      }
      try {
        const res = await fetch(`http://127.0.0.1:${this.opts.port}/api/health`);
        if (res.ok) {
          this.restartAttempts = 0;
          this.setState("running");
          return;
        }
      } catch {
        // Not ready yet
      }
      await new Promise((r) => setTimeout(r, HEALTH_POLL_INTERVAL));
    }
    throw new Error("Daemon did not become healthy within timeout");
  }

  async stop(): Promise<void> {
    this.quitting = true;
    if (!this.child) {
      this.setState("stopped");
      return;
    }

    const child = this.child;
    await new Promise<void>((resolve) => {
      child.on("exit", () => resolve());
      child.kill("SIGTERM");
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch (err: unknown) {
          if (err instanceof Error && (err as NodeJS.ErrnoException).code !== "ESRCH") {
            this.opts.onLog?.(`Warning: failed to force-kill daemon: ${err}`);
          }
        }
        resolve();
      }, 5_000);
    });
    this.child = null;
    this.setState("stopped");
  }

  private setState(state: DaemonState) {
    this.state = state;
    this.opts.onStateChange?.(state);
  }
}

/** Check if a port is available */
export function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: "127.0.0.1" });
    socket.on("connect", () => {
      socket.destroy();
      resolve(false);
    });
    socket.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code !== "ECONNREFUSED") {
        console.warn(`Unexpected error checking port ${port}: ${err.code}`);
      }
      // ECONNREFUSED = nothing listening = available. Other errors (ETIMEDOUT, etc.)
      // also likely mean no service, so treat as available and let spawn fail if not.
      resolve(true);
    });
  });
}

/** Find an available port starting from the given port */
export async function findAvailablePort(startPort: number): Promise<number> {
  for (let port = startPort; port < startPort + 100; port++) {
    if (await isPortAvailable(port)) return port;
  }
  throw new Error(`No available port found in range ${startPort}-${startPort + 99}`);
}
