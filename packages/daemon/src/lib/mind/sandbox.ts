import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
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

/** Raised when sandbox isolation is required but unavailable, so callers fail closed. */
export class SandboxUnavailableError extends Error {
  constructor(reason: string, cause?: unknown) {
    super(
      `${reason} — refusing to run unsandboxed. Fix the sandbox runtime, or set VOLUTE_SANDBOX_OPTIONAL=1 to allow running without isolation.`,
      cause ? { cause } : undefined,
    );
    this.name = "SandboxUnavailableError";
  }
}

/** Check if sandbox isolation is enabled via config. */
export function isSandboxEnabled(): boolean {
  if (process.env.VOLUTE_SANDBOX === "0") return false;
  return readGlobalConfig().setup?.isolation === "sandbox";
}

/**
 * Explicit opt-out that lets a sandbox-mode daemon degrade to running minds
 * WITHOUT isolation when the runtime can't be set up. For local dev only —
 * never set this on a shared/system install.
 */
export function isSandboxOptional(): boolean {
  return process.env.VOLUTE_SANDBOX_OPTIONAL === "1";
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
        // Fail closed: without these deps the sandbox can't restrict minds.
        throw new SandboxUnavailableError(`sandbox dependencies missing: ${errors.join(", ")}`);
      }
    }

    // Leave network.allowedDomains/deniedDomains unset so the sandbox doesn't set
    // up a proxy. All minds need direct API access and the proxy breaks clients
    // that don't respect HTTP_PROXY (e.g. the claude subprocess spawned by the
    // Agent SDK). Without network.allowedDomains, wrapWithSandbox generates a
    // seatbelt profile with `(allow network*)` — unrestricted network while
    // filesystem restrictions still apply. `network` itself must still be present:
    // SandboxManager.initialize() reads `runtimeConfig.network.parentProxy` directly
    // (added in sandbox-runtime 0.0.56) and throws a TypeError if `network` is missing.
    const config = {
      filesystem: {
        denyRead: [],
        allowWrite: [],
        denyWrite: [],
      },
      network: {},
      ...(ripgrepConfig ? { ripgrep: ripgrepConfig } : {}),
    } as unknown as SandboxRuntimeConfig;
    await SandboxManager.initialize(config);
    sandboxManager = SandboxManager;
  } catch (err) {
    // A deliberate fail-closed signal — surface it as-is (or degrade if opted out).
    if (err instanceof SandboxUnavailableError) {
      if (isSandboxOptional()) {
        slog.error(
          "sandbox unavailable but VOLUTE_SANDBOX_OPTIONAL=1 — minds will run WITHOUT isolation",
          log.errorData(err),
        );
        return;
      }
      throw err;
    }
    // Runtime import/initialize failure.
    if (isSandboxOptional()) {
      slog.error(
        "sandbox runtime not available but VOLUTE_SANDBOX_OPTIONAL=1 — minds will run WITHOUT isolation",
        log.errorData(err),
      );
      return;
    }
    throw new SandboxUnavailableError("sandbox runtime not available", err);
  }
}

/**
 * Locate every path a sandboxed mind must be able to read to execute the `volute`
 * CLI: the bin shim on PATH, the node install prefix, and the package root the
 * shim resolves to.
 *
 * All three are needed. npm installs the shim as a symlink into
 * `<prefix>/lib/node_modules/volute`, which under `npm link` is itself a symlink
 * elsewhere. Seatbelt checks every hop it resolves, so a denied intermediate link
 * fails the whole lookup — and the CLI bundle then loads sibling chunks and
 * node_modules from the package root.
 *
 * Skips any `.local/bin` dir — that holds the mind's own wrapper, which re-scans
 * PATH for the real CLI and reports "volute: command not found" if it finds none.
 */
export function voluteCliPaths(env: NodeJS.ProcessEnv = process.env): string[] {
  for (const dir of (env.PATH ?? "").split(":")) {
    if (!dir || dir.endsWith("/.local/bin")) continue;
    const shim = resolve(dir, "volute");
    if (!existsSync(shim)) continue;

    const paths = [shim, resolve(dirname(process.execPath), "..")];
    let target: string;
    try {
      target = realpathSync(shim);
    } catch {
      return paths;
    }
    for (let dir = dirname(target); dir !== dirname(dir); dir = dirname(dir)) {
      if (existsSync(resolve(dir, "package.json"))) {
        paths.push(dir);
        break;
      }
    }
    return paths;
  }
  return [];
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
  // The sandbox runtime already exempts the node binary itself, but not the
  // volute CLI. When it lives under $HOME (nvm, npm --prefix=~) the blanket
  // denyRead below hides it, and a mind loses its only way to act or speak.
  const allowRead: string[] = [mindDir, ...voluteCliPaths()];

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
 * Extra directories a sandboxed mind must be able to write to for the shell's
 * here-documents to work.
 *
 * macOS ships bash 3.2, whose here-document handling writes the body to a temp
 * file under /tmp (→ /private/tmp, then /var/tmp) and IGNORES $TMPDIR — so a
 * mind running `cat <<'X' … X` fails with "cannot create temp file for here
 * document: operation not permitted" unless the seatbelt sandbox can write
 * there. sandbox-runtime only whitelists /tmp/claude (the dir it points TMPDIR
 * at), which bash 3.2 never consults. Linux ships modern bash that honors that
 * TMPDIR=/tmp/claude, so it needs nothing extra here.
 */
export function shellTempWritePaths(): string[] {
  return process.platform === "darwin" ? ["/private/tmp", "/private/var/tmp"] : [];
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
  if (!sandboxManager) {
    // Fail closed unless explicitly opted out or sandbox mode is off entirely.
    if (isSandboxEnabled() && !isSandboxOptional()) {
      throw new SandboxUnavailableError(`cannot sandbox mind ${mindName}`);
    }
    return [cmd, args];
  }

  const { denyRead, allowRead } = await buildSandboxReadConfig(mindName, mindDir);
  const customConfig: Partial<SandboxRuntimeConfig> = {
    filesystem: {
      denyRead,
      allowRead,
      allowWrite: [...(allowWrite ?? [mindDir]), ...shellTempWritePaths()],
      denyWrite: [],
    },
  };

  try {
    const shellCmd = [cmd, ...args].map(shellEscape).join(" ");
    const wrapped = await sandboxManager.wrapWithSandbox(shellCmd, undefined, customConfig);
    return ["bash", ["-c", wrapped]];
  } catch (err) {
    // Fail closed unless explicitly opted out.
    if (isSandboxEnabled() && !isSandboxOptional()) {
      throw new SandboxUnavailableError(`failed to sandbox mind ${mindName}`, err);
    }
    slog.error(
      `failed to sandbox mind ${mindName} — running without isolation`,
      log.errorData(err),
    );
    return [cmd, args];
  }
}
