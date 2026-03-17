import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { log } from "./logger.js";

export type HookResult = {
  additionalContext?: string;
  metadata?: Record<string, unknown>;
  decision?: "block";
};

export type AggregatedResult = {
  additionalContext?: string;
  metadata: Record<string, unknown>;
  blocked: boolean;
};

const DEFAULT_TIMEOUT = 5000;

/**
 * Discover hook scripts in `.config/hooks/<event>/`, sorted alphabetically.
 */
export function discoverHooks(hooksDir: string, event: string): string[] {
  const dir = resolve(hooksDir, event);
  if (!existsSync(dir)) return [];

  try {
    return readdirSync(dir)
      .filter((f) => /\.(sh|ts|js)$/.test(f))
      .sort()
      .map((f) => join(dir, f));
  } catch (err) {
    log(
      "hooks",
      `failed to read hooks directory ${dir}: ${err instanceof Error ? err.message : err}`,
    );
    return [];
  }
}

/**
 * Select the runner command for a hook script based on its extension.
 */
function getRunner(scriptPath: string): { cmd: string; args: string[] } {
  const ext = extname(scriptPath);
  if (ext === ".ts") return { cmd: "npx", args: ["tsx", scriptPath] };
  if (ext === ".js") return { cmd: "node", args: [scriptPath] };
  return { cmd: "bash", args: [scriptPath] };
}

/**
 * Execute a single hook script with JSON on stdin, parse JSON from stdout.
 */
export function executeHook(
  scriptPath: string,
  input: object,
  timeout = DEFAULT_TIMEOUT,
): Promise<HookResult> {
  return new Promise((resolve) => {
    const { cmd, args } = getRunner(scriptPath);
    const child = spawn(cmd, args, {
      timeout,
      stdio: ["pipe", "pipe", "pipe"],
      cwd: process.cwd(),
      env: process.env,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });

    // Ignore stdin errors — child may exit before reading (EPIPE)
    child.stdin.on("error", () => {});
    child.stdin.write(JSON.stringify(input));
    child.stdin.end();

    let settled = false;
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (code !== 0) {
        log("hooks", `hook ${scriptPath} exited with code ${code}: ${stderr.trim()}`);
        resolve({});
        return;
      }

      const trimmed = stdout.trim();
      if (!trimmed) {
        resolve({});
        return;
      }

      try {
        const parsed = JSON.parse(trimmed);
        resolve({
          additionalContext: parsed.additionalContext,
          metadata: parsed.metadata,
          decision: parsed.decision,
        });
      } catch {
        log("hooks", `hook ${scriptPath} returned invalid JSON: ${trimmed.slice(0, 200)}`);
        resolve({});
      }
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      log("hooks", `hook ${scriptPath} failed to spawn: ${err.message}`);
      resolve({});
    });
  });
}

/**
 * Discover and run all hooks for an event, aggregating results.
 */
export async function runHooks(
  hooksDir: string,
  event: string,
  input: object,
  timeout = DEFAULT_TIMEOUT,
): Promise<AggregatedResult> {
  const scripts = discoverHooks(hooksDir, event);
  if (scripts.length === 0) return { metadata: {}, blocked: false };

  const contextParts: string[] = [];
  const metadata: Record<string, unknown> = {};
  let blocked = false;

  for (const script of scripts) {
    const result = await executeHook(script, input, timeout);
    if (result.additionalContext) {
      contextParts.push(result.additionalContext);
    }
    if (result.metadata) {
      Object.assign(metadata, result.metadata);
    }
    if (result.decision === "block") {
      blocked = true;
    }
  }

  return {
    additionalContext: contextParts.length > 0 ? contextParts.join("\n\n") : undefined,
    metadata,
    blocked,
  };
}
