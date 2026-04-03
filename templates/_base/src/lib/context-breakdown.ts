import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { ContextBreakdown } from "./volute-server.js";

// Async tokenizer — import fires at module load; falls back to character estimation if unavailable or still loading
let _countTokens: ((text: string) => number) | null = null;
let _tokenizerLoading = false;

async function loadTokenizer(): Promise<void> {
  if (_tokenizerLoading) return;
  _tokenizerLoading = true;
  try {
    const mod = await import("@anthropic-ai/tokenizer");
    _countTokens = mod.countTokens;
  } catch (err) {
    // Tokenizer not installed — fall back to character estimation
    console.warn(
      "context-breakdown: @anthropic-ai/tokenizer not available, using character estimation:",
      err instanceof Error ? err.message : err,
    );
  }
}

// Kick off async tokenizer load at import time
loadTokenizer();

function countTokens(text: string): number {
  if (!_countTokens) return Math.round(text.length / 3.5);
  return _countTokens(text);
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
  claudeMdTokens: number,
  skillDescriptionTokens: number,
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
    breakdown: {
      systemPrompt: systemPromptTokens,
      sdkInstructions: claudeMdTokens,
      skillDescriptions: skillDescriptionTokens,
      conversation: conv,
    },
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
    // function_call fields
    name?: string;
    arguments?: string;
    // function_call_output fields
    output?: string;
    // reasoning fields
    summary?: Array<{ type?: string; text?: string }> | string;
  };
};

export function parseCodexSessionJSONL(
  filePath: string,
  systemPromptTokens: number,
  claudeMdTokens: number,
  skillDescriptionTokens: number,
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
        // Reasoning summaries are in the `summary` field (array of {text} objects)
        const summary = payload.summary;
        if (Array.isArray(summary)) {
          for (const s of summary) {
            if (s && typeof s === "object" && s.text) conv.thinking += countTokens(s.text);
          }
        } else if (typeof summary === "string" && summary) {
          conv.thinking += countTokens(summary);
        }
      } else if (payload.type === "message") {
        const text = payload.content?.map((c) => c.text ?? "").join("") ?? "";
        if (text) {
          if (payload.role === "assistant") {
            conv.assistantText += countTokens(text);
          } else {
            conv.userText += countTokens(text);
          }
        }
      } else if (payload.type === "function_call") {
        const args = payload.arguments ?? "";
        if (args) conv.toolUse += countTokens(args);
      } else if (payload.type === "function_call_output") {
        const output = payload.output ?? "";
        if (output) conv.toolResult += countTokens(output);
      }
    }
  }

  if (lastContextTokens === 0) return null;

  return {
    contextTokens: lastContextTokens,
    breakdown: {
      systemPrompt: systemPromptTokens,
      sdkInstructions: claudeMdTokens,
      skillDescriptions: skillDescriptionTokens,
      conversation: conv,
    },
  };
}

// --- Pi JSONL parser ---

type PiEntry = {
  type: string;
  // message entries
  message?: {
    role?: string;
    usage?: { input?: number; cacheRead?: number; cacheWrite?: number };
    content?: Array<{ type?: string; text?: string; thinking?: string; arguments?: unknown }>;
  };
  // custom_message entries (hook-injected context: reply-instructions, startup-context, etc.)
  content?: string;
};

export function parsePiSessionJSONL(
  filePath: string,
  systemPromptTokens: number,
  claudeMdTokens: number,
  skillDescriptionTokens: number,
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

    // custom_message entries are hook-injected context (reply-instructions, startup-context)
    if (entry.type === "custom_message" && entry.content) {
      conv.userText += countTokens(entry.content);
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
    breakdown: {
      systemPrompt: systemPromptTokens,
      sdkInstructions: claudeMdTokens,
      skillDescriptions: skillDescriptionTokens,
      conversation: conv,
    },
  };
}

// --- Message extraction types ---

export type ContextBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_use"; name: string; input: string }
  | { type: "tool_result"; text: string; isError?: boolean };

export type ContextMessage = {
  role: "user" | "assistant";
  blocks: ContextBlock[];
};

// --- Claude message extraction ---

export function extractClaudeSessionMessages(filePath: string): ContextMessage[] {
  let data: string;
  try {
    data = readFileSync(filePath, "utf-8");
  } catch {
    return [];
  }

  const messages: ContextMessage[] = [];
  for (const line of data.split("\n").filter((l) => l.trim())) {
    let entry: ClaudeMessage;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (entry.type === "assistant" && entry.message) {
      const blocks: ContextBlock[] = [];
      for (const block of entry.message.content ?? []) {
        if (block.type === "thinking" && block.thinking) {
          blocks.push({ type: "thinking", text: block.thinking });
        } else if (block.type === "text" && block.text) {
          blocks.push({ type: "text", text: block.text });
        } else if (block.type === "tool_use") {
          const input = block.input;
          blocks.push({
            type: "tool_use",
            name: (block as any).name ?? "unknown",
            input: typeof input === "string" ? input : JSON.stringify(input ?? {}, null, 2),
          });
        }
      }
      if (blocks.length > 0) messages.push({ role: "assistant", blocks });
    } else if (entry.type === "user" && entry.message) {
      const blocks: ContextBlock[] = [];
      for (const block of entry.message.content ?? []) {
        if (block.type === "tool_result") {
          const content = block.content;
          const isError = (block as any).is_error === true;
          if (typeof content === "string") {
            blocks.push({ type: "tool_result", text: content, isError });
          } else if (Array.isArray(content)) {
            for (const c of content) {
              if (c && typeof c === "object" && "text" in c && typeof c.text === "string") {
                blocks.push({ type: "tool_result", text: c.text, isError });
              }
            }
          }
        } else if (block.type === "text" && block.text) {
          blocks.push({ type: "text", text: block.text });
        }
      }
      if (blocks.length > 0) messages.push({ role: "user", blocks });
    }
  }
  return messages;
}

// --- Codex message extraction ---

export function extractCodexSessionMessages(filePath: string): ContextMessage[] {
  let data: string;
  try {
    data = readFileSync(filePath, "utf-8");
  } catch {
    return [];
  }

  const messages: ContextMessage[] = [];
  for (const line of data.split("\n").filter((l) => l.trim())) {
    let entry: CodexEntry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    const payload = entry.payload;
    if (!payload || entry.type !== "response_item") continue;

    if (payload.type === "reasoning") {
      const blocks: ContextBlock[] = [];
      const summary = payload.summary;
      if (Array.isArray(summary)) {
        for (const s of summary) {
          if (s && typeof s === "object" && s.text) blocks.push({ type: "thinking", text: s.text });
        }
      } else if (typeof summary === "string" && summary) {
        blocks.push({ type: "thinking", text: summary });
      }
      if (blocks.length > 0) messages.push({ role: "assistant", blocks });
    } else if (payload.type === "message") {
      const text = payload.content?.map((c) => c.text ?? "").join("") ?? "";
      if (text) {
        const role = payload.role === "assistant" ? "assistant" : "user";
        messages.push({ role, blocks: [{ type: "text", text }] });
      }
    } else if (payload.type === "function_call") {
      const args = payload.arguments ?? "";
      messages.push({
        role: "assistant",
        blocks: [{ type: "tool_use", name: payload.name ?? "unknown", input: args }],
      });
    } else if (payload.type === "function_call_output") {
      const output = payload.output ?? "";
      if (output) {
        messages.push({ role: "user", blocks: [{ type: "tool_result", text: output }] });
      }
    }
  }
  return messages;
}

// --- Pi message extraction ---

export function extractPiSessionMessages(filePath: string): ContextMessage[] {
  let data: string;
  try {
    data = readFileSync(filePath, "utf-8");
  } catch {
    return [];
  }

  const messages: ContextMessage[] = [];
  for (const line of data.split("\n").filter((l) => l.trim())) {
    let entry: PiEntry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (entry.type === "custom_message" && entry.content) {
      messages.push({ role: "user", blocks: [{ type: "text", text: entry.content }] });
      continue;
    }

    if (entry.type !== "message" || !entry.message) continue;
    const msg = entry.message;

    if (msg.role === "assistant") {
      const blocks: ContextBlock[] = [];
      for (const block of msg.content ?? []) {
        if (block.type === "thinking" && block.thinking) {
          blocks.push({ type: "thinking", text: block.thinking });
        } else if (block.type === "text" && block.text) {
          blocks.push({ type: "text", text: block.text });
        } else if (block.type === "toolCall") {
          const args = block.arguments;
          blocks.push({
            type: "tool_use",
            name: (block as any).name ?? "unknown",
            input: typeof args === "string" ? args : JSON.stringify(args ?? {}, null, 2),
          });
        }
      }
      if (blocks.length > 0) messages.push({ role: "assistant", blocks });
    } else if (msg.role === "toolResult") {
      const blocks: ContextBlock[] = [];
      for (const block of msg.content ?? []) {
        if (block.text) blocks.push({ type: "tool_result", text: block.text });
      }
      if (blocks.length > 0) messages.push({ role: "user", blocks });
    } else if (msg.role === "user") {
      const blocks: ContextBlock[] = [];
      for (const block of msg.content ?? []) {
        if (block.type === "text" && block.text) {
          blocks.push({ type: "text", text: block.text });
        }
      }
      if (blocks.length > 0) messages.push({ role: "user", blocks });
    }
  }
  return messages;
}

// --- Preamble text readers ---

/** Read the SDK instruction file content (CLAUDE.md, MINDS.md, or AGENTS.md). */
export function readSdkInstructions(cwd: string): string {
  for (const name of ["CLAUDE.md", "MINDS.md", "AGENTS.md"]) {
    try {
      return readFileSync(resolve(cwd, name), "utf-8");
    } catch {
      // try next
    }
  }
  return "";
}

/** Read skill names and descriptions from SKILL.md frontmatter. */
export function readSkillDescriptions(
  skillsDirs: string[],
): Array<{ name: string; description: string }> {
  const results: Array<{ name: string; description: string }> = [];
  for (const dir of skillsDirs) {
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        try {
          const content = readFileSync(resolve(dir, entry.name, "SKILL.md"), "utf-8");
          const match = content.match(/^description:\s*(.+?)$/m);
          if (match) results.push({ name: entry.name, description: match[1] });
        } catch {
          // skip
        }
      }
    } catch {
      // skip
    }
  }
  return results;
}

// --- Measure known SDK overhead ---

/** Count tokens in the actual composed system prompt string. */
export function countSystemPromptTokens(systemPrompt: string): number {
  return countTokens(systemPrompt);
}

/** Count tokens in the SDK instruction file (CLAUDE.md, MINDS.md, or AGENTS.md). */
export function countSdkInstructionTokens(cwd: string): number {
  for (const name of ["CLAUDE.md", "MINDS.md", "AGENTS.md"]) {
    try {
      const content = readFileSync(resolve(cwd, name), "utf-8");
      return countTokens(content);
    } catch (err: any) {
      if (err?.code !== "ENOENT")
        console.warn(`context-breakdown: ${resolve(cwd, name)}:`, err?.message);
    }
  }
  return 0;
}

/** Count tokens in skill description frontmatter (always in context). */
export function countSkillDescriptionTokens(skillsDirs: string[]): number {
  let total = 0;
  for (const dir of skillsDirs) {
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        try {
          const content = readFileSync(resolve(dir, entry.name, "SKILL.md"), "utf-8");
          // Extract just the frontmatter description — that's what's always in context
          const match = content.match(/^description:\s*(.+?)$/m);
          if (match) total += countTokens(match[1]);
        } catch (err: any) {
          if (err?.code !== "ENOENT")
            console.warn(`context-breakdown: SKILL.md in ${entry.name}:`, err?.message);
        }
      }
    } catch (err: any) {
      if (err?.code !== "ENOENT")
        console.warn(`context-breakdown: skills dir ${dir}:`, err?.message);
    }
  }
  return total;
}

// --- Session file finders ---

/** Find the Claude SDK JSONL file for a session ID. */
export function findClaudeSessionFile(cwd: string, sessionId: string): string | null {
  // The SDK stores JSONL in ~/.claude/projects/ (global), not inside the mind's home dir.
  // Check both the global location and the local one (in case of sandboxed minds).
  const homeDir = process.env.HOME ?? "";
  const dirs = [resolve(homeDir, ".claude/projects"), resolve(cwd, ".claude/projects")];
  for (const projectsDir of dirs) {
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
    } catch (err: any) {
      if (err?.code !== "ENOENT") console.warn(`context-breakdown: ${projectsDir}:`, err?.message);
    }
  }
  return null;
}

/** Find the Codex JSONL file for a thread ID. */
export function findCodexSessionFile(threadId: string, mindDir?: string): string | null {
  // Check mind-local Codex sessions first, then global ~/.codex/sessions
  const searchDirs: string[] = [];
  if (mindDir) searchDirs.push(resolve(mindDir, ".mind/codex/sessions"));
  searchDirs.push(resolve(process.env.HOME ?? "", ".codex/sessions"));

  for (const codexDir of searchDirs) {
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
    } catch (err: any) {
      if (err?.code !== "ENOENT") console.warn("context-breakdown: codex sessions:", err?.message);
    }
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
  } catch (err: any) {
    if (err?.code !== "ENOENT")
      console.warn(`context-breakdown: pi sessions ${dir}:`, err?.message);
    return null;
  }
}
