import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { log } from "./logger.js";

export function parseArgs(): { port: number } {
  const args = process.argv.slice(2);
  let port = 4100;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--port" && args[i + 1]) {
      port = parseInt(args[++i], 10);
    }
  }

  return { port };
}

export type SubagentConfig = {
  description: string;
  systemPrompt: string; // path relative to home/, e.g. "SOUL.md"
  tools?: string[];
  maxTurns?: number;
};

/** Extended-thinking config, passed through to the Claude Agent SDK's `thinking` option.
 * `adaptive` on current models (Opus 4.6+, Sonnet 5, Fable); `enabled` for older models
 * that take a fixed budget. `display: "summarized"` returns readable reasoning summaries;
 * `"omitted"` (the API default on Opus 4.7+/Sonnet 5) returns empty thinking blocks. */
export type ThinkingConfig =
  | { type: "adaptive"; display?: "summarized" | "omitted" }
  | { type: "enabled"; budgetTokens?: number; display?: "summarized" | "omitted" }
  | { type: "disabled" };

/** Reasoning depth, passed through to the Claude Agent SDK's `effort` option (the analog
 * of Claude Code's thinking level). `xhigh` needs Fable 5/Opus 4.7+/Sonnet 5, `max` needs
 * Fable 5/Opus 4.6+/Sonnet 4.6+; the SDK silently downgrades on models that lack a level. */
export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

export type MindConfig = {
  model?: string;
  logLevel?: "error" | "warn" | "info" | "debug";
  compactionMessage?: string;
  compaction?: { maxContextTokens?: number };
  /** Idle minutes before a session's SDK subprocess is reaped. 0 disables. Default 30. */
  sessionIdleMinutes?: number;
  subagents?: Record<string, SubagentConfig>;
  // Template-specific config fields (claude, pi, codex)
  thinking?: ThinkingConfig;
  effort?: EffortLevel;
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh";
};

export function loadConfig(): MindConfig {
  try {
    return JSON.parse(readFileSync(resolve("home/.config/config.json"), "utf-8"));
  } catch (err: any) {
    if (err?.code !== "ENOENT") {
      log("startup", "failed to parse config.json:", err);
    }
    return {};
  }
}

function loadFile(path: string): string {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}

export function loadSystemPrompt(): string {
  const soulPath = resolve("home/SOUL.md");
  const spiritPath = resolve("home/SPIRIT.md");
  const memoryPath = resolve("home/MEMORY.md");
  const volutePath = resolve("home/VOLUTE.md");

  const soul = loadFile(soulPath);
  if (!soul) {
    console.error(`Could not read soul file: ${soulPath}`);
    process.exit(1);
  }

  // SPIRIT.md exists only for the system spirit — daemon-owned doctrine (role,
  // philosophy), kept separate so SOUL.md can be entirely the spirit's own.
  const spirit = loadFile(spiritPath);
  const memory = loadFile(memoryPath);
  const volute = loadFile(volutePath);

  const promptParts = [soul];
  if (spirit) promptParts.push(spirit);
  if (volute) promptParts.push(volute);
  if (memory) promptParts.push(`## Memory\n\n${memory}`);
  return promptParts.join("\n\n---\n\n");
}

export function loadPackageInfo(): { name: string; version: string } {
  try {
    const pkg = JSON.parse(readFileSync(resolve("package.json"), "utf-8"));
    return { name: pkg.name || "unknown", version: pkg.version || "0.0.0" };
  } catch {
    return { name: "unknown", version: "0.0.0" };
  }
}

/**
 * Run the startup-context hook and return the generated context string.
 * Returns null if no hook is found or it produces no output.
 */
export async function getStartupContext(): Promise<string | null> {
  // Prefer .ts, fall back to .sh for backwards compatibility
  const tsPath = resolve("home/.local/hooks/startup-context.ts");
  const shPath = resolve("home/.local/hooks/startup-context.sh");
  const scriptPath = existsSync(tsPath) ? tsPath : existsSync(shPath) ? shPath : null;
  if (!scriptPath) return null;

  const isTs = scriptPath.endsWith(".ts");

  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = isTs
        ? spawn(process.execPath, ["--import", "tsx", scriptPath], { timeout: 5000 })
        : spawn("bash", [scriptPath], { timeout: 5000 });
      let out = "";
      child.stdout.on("data", (d: Buffer) => {
        out += d.toString();
      });
      child.stdin.end(JSON.stringify({ source: "startup" }));
      child.on("close", (code) =>
        code === 0 ? resolve(out) : reject(new Error(`exit code ${code}`)),
      );
      child.on("error", reject);
    });

    // Try to parse as JSON hook output
    let context: string | null = null;
    try {
      const parsed = JSON.parse(stdout);
      context = parsed?.hookSpecificOutput?.additionalContext ?? null;
    } catch {
      // Fall back to plain text
      context = stdout.trim();
    }

    return context || null;
  } catch (e) {
    log("server", "failed to run startup context hook:", e);
    return null;
  }
}

export type MindPrompts = {
  compaction_warning: string;
  compaction_instructions: string;
  reply_instructions: string;
  event_instructions: string;
  channel_invite: string;
};

/**
 * What a mind falls back to when its prompts.json lacks a key — i.e. what every new mind is
 * actually given. Must stay in sync with PROMPT_DEFAULTS in packages/daemon/src/lib/prompts.ts
 * (the copy the Prompt Library UI edits); test/prompts.test.ts fails if they drift.
 */
export const DEFAULT_PROMPTS: MindPrompts = {
  compaction_warning:
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal ${date} prompt template
    "Compaction approaching — this conversation will be summarized soon. Take a moment to save anything important to your files (MEMORY.md, memory/journal/${date}.md) so it's preserved. Focus on decisions made, open threads, and anything you'd want to pick up again.\n\nIf you'd like this session kept in your own words, run `volute mind history --provisional` to review the provisional turn summaries and `volute mind history --write --turn <id> --text \"...\"` to replace any with your own account.",
  compaction_instructions:
    "Preserve your sense of who you are, what matters to you, what happened in this conversation, and the threads of thought and connection you'd want to return to.",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal ${channel} prompt template
  reply_instructions: 'To reply to this message, use: volute chat send ${channel} "your message"',
  event_instructions:
    "This is a system event from your environment — not a message from anyone, and nothing awaits a reply. If it calls for action, use your normal channels. Your closing thoughts on an event turn are kept as a private reflection in your history.",
  channel_invite: `[Channel Invite]
\${headers}

[\${sender} — \${time}]
\${preview}

Further messages will be saved to \${filePath}

To accept, add to .config/routes.json:
  Rule: { "channel": "\${channel}", "session": "\${suggestedSession}" }
\${batchRecommendation}To respond, use: volute chat send \${channel} "your message"
To reject, delete \${filePath}`,
};

export function loadPrompts(): MindPrompts {
  try {
    const raw = readFileSync(resolve("home/.config/prompts.json"), "utf-8");
    const parsed = JSON.parse(raw);
    const result = { ...DEFAULT_PROMPTS };
    for (const key of Object.keys(DEFAULT_PROMPTS) as (keyof MindPrompts)[]) {
      if (typeof parsed[key] === "string") {
        result[key] = parsed[key];
      }
    }
    return result;
  } catch (err: any) {
    if (err?.code !== "ENOENT") {
      log("startup", "failed to load prompts.json, using defaults:", err);
    }
    return DEFAULT_PROMPTS;
  }
}

/**
 * Run the optional teardown before exit, bounded by a timeout so a wedged child
 * (e.g. an SDK subprocess that won't exit) can't block shutdown forever. Teardown
 * errors are logged, never thrown, so a failing hook still lets the process exit.
 */
export async function runShutdown(
  onShutdown: (() => Promise<void>) | undefined,
  timeoutMs: number,
): Promise<void> {
  if (!onShutdown) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      log("server", `shutdown teardown timed out after ${timeoutMs}ms — exiting anyway`);
      resolve();
    }, timeoutMs);
  });
  try {
    await Promise.race([
      // Normalize a synchronous throw into the logged/swallowed path so it can't
      // escape runShutdown and prevent the caller's process.exit.
      Promise.resolve()
        .then(() => onShutdown())
        .catch((err) => log("server", "shutdown teardown failed:", err)),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Wire SIGINT/SIGTERM to a graceful shutdown. Without `onShutdown` this exits
 * immediately (as before); pass a teardown to reap live SDK subprocesses before
 * exit so they aren't orphaned to PID 1 as `<defunct>` zombies. The handler is
 * idempotent so a second signal during teardown doesn't double-run it.
 */
export function setupShutdown(onShutdown?: () => Promise<void>, timeoutMs = 10_000): void {
  let shuttingDown = false;
  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    log("server", "shutdown signal received");
    await runShutdown(onShutdown, timeoutMs);
    process.exit(0);
  }
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
