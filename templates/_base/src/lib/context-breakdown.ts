import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { ContextBreakdown } from "./volute-server.js";

// Lazy-loaded tokenizer — first call loads the encoding (~100ms), subsequent calls are fast
let _countTokens: ((text: string) => number) | null = null;

function countTokens(text: string): number {
  if (!_countTokens) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require("@anthropic-ai/tokenizer");
      _countTokens = mod.countTokens;
    } catch {
      // Tokenizer not installed — fall back to character estimation
      _countTokens = (t: string) => Math.round(t.length / 3.5);
    }
  }
  return _countTokens!(text);
}

// --- Claude JSONL parser ---

type ClaudeContentBlock = {
  type: string;
  text?: string;
  thinking?: string;
  input?: unknown;
  content?: unknown;
};

type ClaudeMessage = {
  type: string;
  message?: {
    role?: string;
    usage?: {
      input_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
    content?: ClaudeContentBlock[];
  };
};

export type ParsedContext = {
  contextTokens: number;
  breakdown: ContextBreakdown;
};

export function parseClaudeSessionJSONL(
  filePath: string,
  systemPromptTokens: number,
): ParsedContext | null {
  let data: string;
  try {
    data = readFileSync(filePath, "utf-8");
  } catch (err: any) {
    if (err?.code !== "ENOENT") console.warn(`context-breakdown: ${filePath}:`, err?.message);
    return null;
  }

  const lines = data.split("\n").filter((l) => l.trim());
  let lastContextTokens = 0;
  const conv = { userText: 0, assistantText: 0, thinking: 0, toolUse: 0, toolResult: 0 };

  for (const line of lines) {
    let entry: ClaudeMessage;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (entry.type === "assistant" && entry.message) {
      const usage = entry.message.usage;
      if (usage) {
        const ctx =
          (usage.input_tokens ?? 0) +
          (usage.cache_creation_input_tokens ?? 0) +
          (usage.cache_read_input_tokens ?? 0);
        if (ctx > 0) lastContextTokens = ctx;
      }
      for (const block of entry.message.content ?? []) {
        if (block.type === "thinking" && block.thinking) {
          conv.thinking += countTokens(block.thinking);
        } else if (block.type === "text" && block.text) {
          conv.assistantText += countTokens(block.text);
        } else if (block.type === "tool_use") {
          const input = block.input;
          conv.toolUse += countTokens(
            typeof input === "string" ? input : JSON.stringify(input ?? {}),
          );
        }
      }
    } else if (entry.type === "user" && entry.message) {
      for (const block of entry.message.content ?? []) {
        if (block.type === "tool_result") {
          const content = block.content;
          if (typeof content === "string") {
            conv.toolResult += countTokens(content);
          } else if (Array.isArray(content)) {
            for (const c of content) {
              if (c && typeof c === "object" && "text" in c && typeof c.text === "string") {
                conv.toolResult += countTokens(c.text);
              }
            }
          }
        } else if (block.type === "text" && block.text) {
          conv.userText += countTokens(block.text);
        }
      }
    }
  }

  if (lastContextTokens === 0) return null;

  return {
    contextTokens: lastContextTokens,
    breakdown: { systemPrompt: systemPromptTokens, conversation: conv },
  };
}

// --- Codex JSONL parser ---

type CodexEntry = {
  type: string;
  payload?: {
    type?: string;
    info?: {
      last_token_usage?: { input_tokens?: number; cached_input_tokens?: number };
      total_token_usage?: { input_tokens?: number };
      model_context_window?: number;
    };
    content?: Array<{ type?: string; text?: string }>;
    role?: string;
  };
};

export function parseCodexSessionJSONL(
  filePath: string,
  systemPromptTokens: number,
): ParsedContext | null {
  let data: string;
  try {
    data = readFileSync(filePath, "utf-8");
  } catch (err: any) {
    if (err?.code !== "ENOENT") console.warn(`context-breakdown: ${filePath}:`, err?.message);
    return null;
  }

  const lines = data.split("\n").filter((l) => l.trim());
  let lastContextTokens = 0;
  const conv = { userText: 0, assistantText: 0, thinking: 0, toolUse: 0, toolResult: 0 };

  for (const line of lines) {
    let entry: CodexEntry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    const payload = entry.payload;
    if (!payload) continue;

    if (entry.type === "event_msg" && payload.type === "token_count" && payload.info) {
      const lastUsage = payload.info.last_token_usage;
      if (lastUsage?.input_tokens) {
        lastContextTokens = lastUsage.input_tokens;
      }
    } else if (entry.type === "response_item") {
      if (payload.type === "reasoning") {
        const text =
          payload.content
            ?.filter((c) => c.type === "input_text")
            .map((c) => c.text ?? "")
            .join("") ?? "";
        if (text) conv.thinking += countTokens(text);
      } else if (payload.type === "message") {
        if (payload.role === "assistant") {
          const text =
            payload.content
              ?.filter((c) => c.type === "output_text")
              .map((c) => c.text ?? "")
              .join("") ?? "";
          if (text) conv.assistantText += countTokens(text);
        } else if (payload.role === "user" || payload.role === "developer") {
          const text =
            payload.content
              ?.filter((c) => c.type === "input_text")
              .map((c) => c.text ?? "")
              .join("") ?? "";
          if (text) conv.userText += countTokens(text);
        }
      } else if (payload.type === "function_call") {
        conv.toolUse += countTokens(JSON.stringify(payload));
      } else if (payload.type === "function_call_output") {
        const text = payload.content?.map((c) => c.text ?? "").join("") ?? "";
        if (text) conv.toolResult += countTokens(text);
      }
    }
  }

  if (lastContextTokens === 0) return null;

  return {
    contextTokens: lastContextTokens,
    breakdown: { systemPrompt: systemPromptTokens, conversation: conv },
  };
}

// --- Pi JSONL parser ---

type PiEntry = {
  type: string;
  message?: {
    role?: string;
    usage?: { input?: number; cacheRead?: number; cacheWrite?: number };
    content?: Array<{ type?: string; text?: string; thinking?: string; arguments?: unknown }>;
  };
};

export function parsePiSessionJSONL(
  filePath: string,
  systemPromptTokens: number,
): ParsedContext | null {
  let data: string;
  try {
    data = readFileSync(filePath, "utf-8");
  } catch (err: any) {
    if (err?.code !== "ENOENT") console.warn(`context-breakdown: ${filePath}:`, err?.message);
    return null;
  }

  const lines = data.split("\n").filter((l) => l.trim());
  let lastContextTokens = 0;
  const conv = { userText: 0, assistantText: 0, thinking: 0, toolUse: 0, toolResult: 0 };

  for (const line of lines) {
    let entry: PiEntry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (entry.type !== "message" || !entry.message) continue;
    const msg = entry.message;

    if (msg.role === "assistant") {
      const usage = msg.usage;
      if (usage) {
        const ctx = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
        if (ctx > 0) lastContextTokens = ctx;
      }
      for (const block of msg.content ?? []) {
        if (block.type === "thinking" && block.thinking) {
          conv.thinking += countTokens(block.thinking);
        } else if (block.type === "text" && block.text) {
          conv.assistantText += countTokens(block.text);
        } else if (block.type === "toolCall") {
          const args = block.arguments;
          conv.toolUse += countTokens(typeof args === "string" ? args : JSON.stringify(args ?? {}));
        }
      }
    } else if (msg.role === "toolResult") {
      for (const block of msg.content ?? []) {
        if (block.text) conv.toolResult += countTokens(block.text);
      }
    } else if (msg.role === "user") {
      for (const block of msg.content ?? []) {
        if (block.type === "text" && block.text) {
          conv.userText += countTokens(block.text);
        }
      }
    }
  }

  if (lastContextTokens === 0) return null;

  return {
    contextTokens: lastContextTokens,
    breakdown: { systemPrompt: systemPromptTokens, conversation: conv },
  };
}

// --- Tokenize system prompt ---

/** Count tokens in the actual composed system prompt string. */
export function countSystemPromptTokens(systemPrompt: string): number {
  return countTokens(systemPrompt);
}

// --- Session file finders ---

/** Find the Claude SDK JSONL file for a session ID. */
export function findClaudeSessionFile(cwd: string, sessionId: string): string | null {
  const projectsDir = resolve(cwd, ".claude/projects");
  try {
    for (const dir of readdirSync(projectsDir)) {
      const candidate = resolve(projectsDir, dir, `${sessionId}.jsonl`);
      try {
        statSync(candidate);
        return candidate;
      } catch {
        // Not in this project dir
      }
    }
  } catch {
    // No projects dir
  }
  return null;
}

/** Find the Codex JSONL file for a thread ID. */
export function findCodexSessionFile(threadId: string): string | null {
  const codexDir = resolve(process.env.HOME ?? "", ".codex/sessions");
  try {
    for (const year of readdirSync(codexDir)) {
      const yearDir = resolve(codexDir, year);
      try {
        if (!statSync(yearDir).isDirectory()) continue;
      } catch {
        continue;
      }
      for (const month of readdirSync(yearDir)) {
        const monthDir = resolve(yearDir, month);
        try {
          if (!statSync(monthDir).isDirectory()) continue;
        } catch {
          continue;
        }
        for (const day of readdirSync(monthDir)) {
          const dayDir = resolve(monthDir, day);
          try {
            if (!statSync(dayDir).isDirectory()) continue;
          } catch {
            continue;
          }
          for (const file of readdirSync(dayDir)) {
            if (file.endsWith(".jsonl") && file.includes(threadId)) {
              return resolve(dayDir, file);
            }
          }
        }
      }
    }
  } catch {
    // No codex sessions dir
  }
  return null;
}

/** Find the latest Pi JSONL file for a session name. */
export function findPiSessionFile(sessionsDir: string, sessionName: string): string | null {
  const dir = resolve(sessionsDir, sessionName);
  try {
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .sort();
    if (files.length === 0) return null;
    return resolve(dir, files[files.length - 1]);
  } catch {
    return null;
  }
}
