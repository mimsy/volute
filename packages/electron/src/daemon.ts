import { type ChildProcess, spawn } from "node:child_process";
import { createConnection } from "node:net";

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

  constructor(opts: DaemonOptions) {
    this.opts = opts;
  }

  getState(): DaemonState {
    return this.state;
  }

  getPort(): number {
    return this.opts.port;
  }

  async start(): Promise<void> {
    if (this.child) return;

    // Check if port is already in use by a compatible daemon
    const reused = await this.tryReuseExisting();
    if (reused) return;

    await this.spawn();
  }

  private async tryReuseExisting(): Promise<boolean> {
    try {
      const res = await fetch(`http://127.0.0.1:${this.opts.port}/api/health`);
      if (res.ok) {
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
      this.opts.onLog?.(`Daemon exited with code ${code}, restarting in ${RESTART_DELAY}ms...`);
      this.setState("error");
      setTimeout(() => {
        if (!this.quitting) {
          this.spawn().catch((err) => {
            this.opts.onLog?.(`Failed to restart daemon: ${err}`);
          });
        }
      }, RESTART_DELAY);
    });

    // Wait for health check
    await this.waitForHealth();
  }

  private async waitForHealth(): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < HEALTH_TIMEOUT) {
      try {
        const res = await fetch(`http://127.0.0.1:${this.opts.port}/api/health`);
        if (res.ok) {
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
    if (!this.child) return;

    const child = this.child;
    await new Promise<void>((resolve) => {
      child.on("exit", () => resolve());
      child.kill("SIGTERM");
      // Force kill after 5s
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {}
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
    socket.on("error", () => {
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
