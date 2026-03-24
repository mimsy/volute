import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
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

export type MindConfig = {
  model?: string;
  logLevel?: "error" | "warn" | "info" | "debug";
  compactionMessage?: string;
  compaction?: { maxContextTokens?: number };
  subagents?: Record<string, SubagentConfig>;
  // Template-specific config fields (claude, pi, codex)
  maxThinkingTokens?: number;
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
  const memoryPath = resolve("home/MEMORY.md");
  const volutePath = resolve("home/VOLUTE.md");

  const soul = loadFile(soulPath);
  if (!soul) {
    console.error(`Could not read soul file: ${soulPath}`);
    process.exit(1);
  }

  const memory = loadFile(memoryPath);
  const volute = loadFile(volutePath);

  const promptParts = [soul];
  if (volute) promptParts.push(volute);
  if (memory) promptParts.push(`## Memory\n\n${memory}`);
  return promptParts.join("\n\n---\n\n");
}

/** Returns character counts for each system prompt component file. */
export function getSystemPromptSizes(): { soul: number; volute: number; memory: number } {
  return {
    soul: loadFile(resolve("home/SOUL.md")).length,
    volute: loadFile(resolve("home/VOLUTE.md")).length,
    memory: loadFile(resolve("home/MEMORY.md")).length,
  };
}

const CHARS_PER_TOKEN = 3.5;

/** Returns estimated token sizes for each installed skill. */
export function getSkillsSizes(skillsDir: string): {
  total: number;
  items: Array<{ name: string; tokens: number }>;
} {
  const items: Array<{ name: string; tokens: number }> = [];
  try {
    const entries = readdirSync(skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillMd = resolve(skillsDir, entry.name, "SKILL.md");
      try {
        const size = statSync(skillMd).size;
        items.push({ name: entry.name, tokens: Math.round(size / CHARS_PER_TOKEN) });
      } catch {
        // No SKILL.md — skip
      }
    }
  } catch {
    // Skills dir doesn't exist
  }
  const total = items.reduce((sum, s) => sum + s.tokens, 0);
  return { total, items };
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
  channel_invite: string;
};

const DEFAULT_PROMPTS: MindPrompts = {
  compaction_warning:
    "Context is getting long — compaction is about to summarize this conversation. Before that happens, save anything important to files (MEMORY.md, memory/journal/${date}.md, etc.) since those survive compaction. Focus on: decisions made, open tasks, and anything you'd need to pick up where you left off.",
  compaction_instructions:
    "Preserve your sense of who you are, what matters to you, what happened in this conversation, and the threads of thought and connection you'd want to return to.",
  reply_instructions: 'To reply to this message, use: volute chat send ${channel} "your message"',
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

export function setupShutdown(): void {
  function shutdown() {
    log("server", "shutdown signal received");
    process.exit(0);
  }
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
