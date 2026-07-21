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
  /**
   * Session continuity across restarts. When a fresh persistent session starts,
   * the tail of the previous session's transcript (up to `seedTokens` estimated
   * tokens) is copied into it so the conversation continues. Default 30000; 0 disables.
   */
  continuity?: { seedTokens?: number };
  /**
   * MEMORY.md token budgets (estimated as chars/4). Over `softBudgetTokens` a
   * consolidation nudge is added to the system prompt; over `hardCapTokens` only
   * the head of the file is loaded (the file on disk is never modified).
   */
  memory?: { softBudgetTokens?: number; hardCapTokens?: number };
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

/** Default MEMORY.md budgets, overridable via `memory` in home/.config/config.json. */
export const MEMORY_SOFT_BUDGET_TOKENS = 5000;
export const MEMORY_HARD_CAP_TOKENS = 25000;

export function estimateTokens(chars: number): number {
  return Math.round(chars / 4);
}

export function formatTokens(tokens: number): string {
  if (tokens < 1000) return `~${tokens} tokens`;
  // One decimal so a value just past a budget doesn't render as the budget
  // itself ("~5.1k tokens ... budget of ~5k tokens", not "~5k ... ~5k").
  return `~${(tokens / 1000).toFixed(1).replace(/\.0$/, "")}k tokens`;
}

/** Current MEMORY.md size as a "~Nk tokens" label, for prompt substitution. */
export function memorySizeLabel(): string {
  return formatTokens(estimateTokens(loadFile(resolve("home/MEMORY.md")).length));
}

/**
 * Render the compaction warning for sending: substitute ${date} and
 * ${memory_size} with current values. Called per send — the date rolls over
 * and MEMORY.md changes as the mind edits it.
 */
export function renderCompactionWarning(template: string): string {
  return (
    template
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal ${date} placeholder
      .replaceAll("${date}", new Date().toLocaleDateString("en-CA"))
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal ${memory_size} placeholder
      .replaceAll("${memory_size}", memorySizeLabel())
  );
}

function headAtLineBoundary(text: string, maxChars: number): string {
  const cut = text.lastIndexOf("\n", maxChars);
  // Prefer a whole-line cut, but not when the nearest newline is so far back
  // that it would discard most of the allowed head (one giant line).
  if (cut >= maxChars / 2) return text.slice(0, cut);
  let head = text.slice(0, maxChars);
  // Don't split a surrogate pair at a hard cut.
  const last = head.charCodeAt(head.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) head = head.slice(0, -1);
  return head;
}

/**
 * The Memory section of the system prompt: header carries the token cost so the
 * mind sees what its memory weighs on every request; over the soft budget a
 * consolidation nudge is added; over the hard cap only the head is loaded (the
 * file on disk is never touched) with a loud notice explaining how to recover.
 */
export function buildMemorySection(memory: string, config: MindConfig): string {
  // typeof guards mirror the daemon's getMemoryStatus: a malformed override
  // (null, string) falls back to the default instead of poisoning arithmetic.
  const softBudget =
    typeof config.memory?.softBudgetTokens === "number"
      ? config.memory.softBudgetTokens
      : MEMORY_SOFT_BUDGET_TOKENS;
  const hardCap =
    typeof config.memory?.hardCapTokens === "number"
      ? config.memory.hardCapTokens
      : MEMORY_HARD_CAP_TOKENS;
  const totalTokens = estimateTokens(memory.length);

  let body = memory;
  let notice = "";
  if (totalTokens > hardCap) {
    body = headAtLineBoundary(memory, hardCap * 4);
    notice =
      `\n\n⚠ MEMORY.md is ${formatTokens(totalTokens)} — only the first ` +
      `${formatTokens(hardCap)} are loaded. The full file is untouched on disk. ` +
      `Consolidate it to restore your full memory.`;
  }

  const loadedTokens = estimateTokens(body.length);
  let header = `## Memory (${formatTokens(loadedTokens)}, always loaded)`;
  if (!notice && loadedTokens > softBudget) {
    header +=
      `\n\nYour memory exceeds the recommended budget of ${formatTokens(softBudget)} — ` +
      `consider consolidating; see the memory skill.`;
  }

  return `${header}\n\n${body}${notice}`;
}

export function loadSystemPrompt(config: MindConfig = loadConfig()): string {
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
  if (memory) promptParts.push(buildMemorySection(memory, config));
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
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal ${cutoff}/${date}/${memory_size} prompt template
    "Context limit approaching — this session will rotate shortly. Turns before ${cutoff} will be collapsed to their summaries; turns from ${cutoff} on are kept verbatim in the continued session, so there's no need to re-describe them.\n\nFor the turns that will collapse, make sure they read the way you'd want: `volute mind history --provisional` shows the provisional summaries, and `volute mind history --write --turn <id> --text \"...\"` replaces any with your own account. Also save anything important to your files (memory/journal/${date}.md, or a memory/ file). Provisional summaries are kept if you write nothing — nothing blocks on this.\n\nYour MEMORY.md is currently ${memory_size}. It is loaded into every request, so consolidate rather than append — distill detail into memory/ files and keep MEMORY.md lean (see the memory skill).",
  compaction_instructions:
    "Preserve your sense of who you are, what matters to you, what happened in this conversation, and the threads of thought and connection you'd want to return to.",
  // Quoted: `${channel}` is `#garden` for a Volute channel, and an unquoted `#` starts a
  // shell comment, so the target would be stripped before the CLI saw it.
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal ${channel} prompt template
  reply_instructions: 'To reply to this message, use: volute chat send "${channel}" "your message"',
  event_instructions:
    "This is a system event from your environment — not a message from anyone, and nothing awaits a reply. If it calls for action, use your normal channels. Your closing thoughts on an event turn are kept as a private reflection in your history.",
  channel_invite: `[Channel Invite]
\${headers}

[\${sender} — \${time}]
\${preview}

Further messages will be saved to \${filePath}

To accept, add to .config/routes.json:
  Rule: { "channel": "\${channel}", "session": "\${suggestedSession}" }
\${batchRecommendation}To respond, use: volute chat send "\${channel}" "your message"
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
