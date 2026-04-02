import { execFileSync } from "node:child_process";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { readGlobalConfig } from "../config/setup.js";
import log from "../util/logger.js";

type SandboxManagerType = {
  initialize(config: SandboxRuntimeConfig): Promise<void>;
  wrapWithSandbox(
    command: string,
    binShell?: string,
    customConfig?: Partial<SandboxRuntimeConfig>,
    abortSignal?: AbortSignal,
  ): Promise<string>;
  checkDependencies(ripgrepConfig?: { command: string }): {
    errors: string[];
    warnings: string[];
  };
};

const slog = log.child("sandbox");

let sandboxManager: SandboxManagerType | null = null;

/** Check if sandbox isolation is enabled via config. */
export function isSandboxEnabled(): boolean {
  if (process.env.VOLUTE_SANDBOX === "0") return false;
  return readGlobalConfig().setup?.isolation === "sandbox";
}

/** Find a ripgrep binary: VOLUTE_RIPGREP_PATH env var, then system PATH. */
function findRipgrep(): string | null {
  if (process.env.VOLUTE_RIPGREP_PATH) {
    try {
      execFileSync(process.env.VOLUTE_RIPGREP_PATH, ["--version"], {
        encoding: "utf-8",
        timeout: 5000,
      });
      return process.env.VOLUTE_RIPGREP_PATH;
    } catch {
      slog.warn(
        `VOLUTE_RIPGREP_PATH set to ${process.env.VOLUTE_RIPGREP_PATH} but binary not executable — falling back to system PATH`,
      );
    }
  }
  try {
    return execFileSync("which", ["rg"], { encoding: "utf-8" }).trim() || null;
  } catch {
    return null;
  }
}

/** Initialize the sandbox runtime. Call once at daemon startup. */
export async function initSandbox(): Promise<void> {
  if (!isSandboxEnabled()) return;

  try {
    const { SandboxManager } = await import("@anthropic-ai/sandbox-runtime");

    const rgPath = findRipgrep();
    const ripgrepConfig = rgPath ? { command: rgPath } : undefined;

    // On Linux, ripgrep is required for filesystem deny scanning
    const { errors, warnings } = SandboxManager.checkDependencies(ripgrepConfig);
    if (warnings.length > 0) {
      slog.warn(`sandbox dependency warnings: ${warnings.join(", ")}`);
    }
    if (errors.length > 0) {
      if (process.platform === "darwin") {
        // macOS sandbox profiles use native glob matching — ripgrep not needed
        slog.warn(`sandbox dependency issues (non-fatal on macOS): ${errors.join(", ")}`);
      } else {
        slog.error(
          `sandbox dependencies missing — minds will run without sandbox isolation: ${errors.join(", ")}`,
        );
        return;
      }
    }

    const config: SandboxRuntimeConfig = {
      network: {
        allowedDomains: ["*"],
        deniedDomains: [],
        allowLocalBinding: true,
        allowAllUnixSockets: true,
      },
      filesystem: {
        denyRead: [],
        allowWrite: [],
        denyWrite: [],
      },
      ...(ripgrepConfig ? { ripgrep: ripgrepConfig } : {}),
    };
    await SandboxManager.initialize(config);
    sandboxManager = SandboxManager;
  } catch (err) {
    slog.error(
      "sandbox runtime not available — minds will run without sandbox isolation",
      log.errorData(err),
    );
  }
}

/**
 * Build deny/allow read lists for a mind's sandbox.
 * Strategy: deny the user's entire home directory, then re-allow just the mind's
 * own directory via allowRead. This is much more restrictive than cherry-picking
 * sensitive paths — the mind can only read its own files plus system paths
 * (node, libraries, etc. outside $HOME).
 */
export async function buildSandboxReadConfig(
  _mindName: string,
  mindDir: string,
): Promise<{ denyRead: string[]; allowRead: string[] }> {
  const userHome = process.env.HOME || "";

  const denyRead: string[] = [];
  const allowRead: string[] = [mindDir];

  // Block user's entire home directory — covers .ssh, .aws, .gnupg, .config,
  // other projects, other minds, volute system state, etc.
  if (userHome) {
    denyRead.push(userHome);
  } else {
    slog.warn("$HOME is not set — sandbox read restrictions will be limited");
  }

  // On system installs, also block /Users (macOS) or /home (Linux) to cover
  // all user directories, not just the daemon's $HOME.
  if (process.env.VOLUTE_ISOLATION === "user") {
    const usersDir = process.platform === "darwin" ? "/Users" : "/home";
    if (!denyRead.includes(usersDir)) {
      denyRead.push(usersDir);
    }
  }

  return { denyRead, allowRead };
}

export function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Wrap a command for sandbox execution.
 * Returns [cmd, args] ready for spawn().
 * If sandbox is not available, returns the original command unchanged.
 */
export async function wrapForSandbox(
  cmd: string,
  args: string[],
  mindDir: string,
  mindName: string,
  allowWrite?: string[],
): Promise<[string, string[]]> {
  if (!sandboxManager) return [cmd, args];

  const { denyRead, allowRead } = await buildSandboxReadConfig(mindName, mindDir);
  const customConfig: Partial<SandboxRuntimeConfig> = {
    filesystem: {
      denyRead,
      allowRead,
      allowWrite: allowWrite ?? [mindDir],
      denyWrite: [],
    },
  };

  try {
    const shellCmd = [cmd, ...args].map(shellEscape).join(" ");
    const wrapped = await sandboxManager.wrapWithSandbox(shellCmd, undefined, customConfig);
    return ["bash", ["-c", wrapped]];
  } catch (err) {
    slog.error(
      `failed to sandbox mind ${mindName} — running without isolation`,
      log.errorData(err),
    );
    return [cmd, args];
  }
}
