import { resolve } from "node:path";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import log from "./logger.js";
import {
  getBaseName,
  readRegistry,
  voluteHome,
  voluteSystemDir,
  voluteUserHome,
} from "./registry.js";
import { readGlobalConfig } from "./setup.js";

type SandboxManagerType = {
  initialize(config: SandboxRuntimeConfig): Promise<void>;
  wrapWithSandbox(
    command: string,
    binShell?: string,
    customConfig?: Partial<SandboxRuntimeConfig>,
    abortSignal?: AbortSignal,
  ): Promise<string>;
};

const slog = log.child("sandbox");

let sandboxManager: SandboxManagerType | null = null;

/** Check if sandbox isolation is enabled via config. */
export function isSandboxEnabled(): boolean {
  if (process.env.VOLUTE_SANDBOX === "0") return false;
  return readGlobalConfig().setup?.isolation === "sandbox";
}

/** Initialize the sandbox runtime. Call once at daemon startup. */
export async function initSandbox(): Promise<void> {
  if (!isSandboxEnabled()) return;

  try {
    const { SandboxManager } = await import("@anthropic-ai/sandbox-runtime");
    // Initialize with permissive defaults — per-mind restrictions applied via wrapWithSandbox
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
 * Build the deny-read list for a mind process.
 * Blocks access to other minds' dirs, system state, and sensitive user dirs.
 */
export async function buildDenyRead(mindName: string, mindDir: string): Promise<string[]> {
  const home = voluteHome();
  const userHome = process.env.HOME || "";
  const mindsDir = process.env.VOLUTE_MINDS_DIR || resolve(home, "minds");

  const deny: string[] = [];

  // Block entire system directory (db, registry, daemon config, env, state, etc.)
  deny.push(voluteSystemDir());

  // Block user-specific files on system installs (where voluteUserHome != voluteHome)
  const userVoluteHome = voluteUserHome();
  if (userVoluteHome !== home) {
    deny.push(userVoluteHome);
  }

  // Other minds — deny each individually since the mind's own dir is inside the same parent
  try {
    const entries = await readRegistry();
    for (const entry of entries) {
      if (entry.name === (await getBaseName(mindName))) continue;
      const otherDir = resolve(mindsDir, entry.name);
      if (otherDir !== mindDir) {
        deny.push(otherDir);
      }
    }
  } catch (err) {
    slog.warn("failed to read minds registry for deny-read list", log.errorData(err));
  }

  // Sensitive user directories
  if (userHome) {
    deny.push(resolve(userHome, ".ssh"));
    deny.push(resolve(userHome, ".aws"));
    deny.push(resolve(userHome, ".gnupg"));
    deny.push(resolve(userHome, ".config"));
  }

  return deny;
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

  const denyRead = await buildDenyRead(mindName, mindDir);
  const customConfig: Partial<SandboxRuntimeConfig> = {
    filesystem: {
      denyRead,
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
