import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

// --- Types ---

type CursorState = Record<string, Record<string, { offset: number }>>;

type ParsedEntry = {
  role: "user" | "assistant";
  timestamp?: string;
  text?: string;
  toolUses?: { name: string; primaryArg?: string }[];
};

type SessionSummary = {
  firstUserText: string;
  toolCounts: { edits: number; reads: number; commands: number; other: number };
  messageCount: number;
  timeSpan: { first?: string; last?: string };
  lastAssistantText?: string;
};

type Format = "agent-sdk" | "pi";

// --- Public API ---

export function getSessionUpdates(options: {
  currentSession: string;
  sessionsDir: string;
  cursorFile: string;
  jsonlResolver: (sessionName: string) => string | null;
  format: Format;
}): string | null {
  const sessionNames = listSessionNames(options.sessionsDir, options.format);
  const others = sessionNames.filter((n) => n !== options.currentSession && !n.startsWith("new-"));
  if (others.length === 0) return null;

  const cursors = loadCursors(options.cursorFile);
  const currentCursors = cursors[options.currentSession] ?? {};
  const summaries: string[] = [];

  for (const name of others) {
    try {
      const jsonlPath = options.jsonlResolver(name);
      if (!jsonlPath || !existsSync(jsonlPath)) continue;

      const stat = statSync(jsonlPath);
      const prevOffset = currentCursors[name]?.offset ?? 0;
      const fileSize = stat.size;

      // Reset if offset past EOF (file was truncated/recreated)
      const offset = prevOffset > fileSize ? 0 : prevOffset;
      if (offset >= fileSize) {
        currentCursors[name] = { offset: fileSize };
        continue;
      }

      const newBytes = readBytesFrom(jsonlPath, offset, fileSize - offset);
      const lines = newBytes.split("\n").filter((l) => l.trim());
      const entries = parseJsonlEntries(lines, options.format);
      const summary = summarizeEntries(entries);

      currentCursors[name] = { offset: fileSize };

      if (!summary) continue;

      const ago = summary.timeSpan.last ? formatTimeAgo(summary.timeSpan.last) : "recently";
      const parts = [`- ${name} (${ago}, ${summary.messageCount} messages)`];

      if (summary.firstUserText) {
        parts[0] += `: "${truncate(summary.firstUserText, 100)}"`;
      }

      const actions: string[] = [];
      if (summary.toolCounts.edits > 0) actions.push(`edited ${summary.toolCounts.edits} files`);
      if (summary.toolCounts.commands > 0)
        actions.push(`ran ${summary.toolCounts.commands} commands`);
      if (summary.toolCounts.reads > 0) actions.push(`read ${summary.toolCounts.reads} files`);
      if (summary.toolCounts.other > 0) actions.push(`${summary.toolCounts.other} other tool uses`);
      if (actions.length > 0) {
        parts[0] += ` -> ${actions.join(", ")}`;
      }

      summaries.push(parts[0]);
    } catch {}
  }

  cursors[options.currentSession] = currentCursors;
  try {
    saveCursors(options.cursorFile, cursors);
  } catch {
    // Non-fatal: worst case is duplicate summaries on next check
  }

  if (summaries.length === 0) return null;

  // Cap total output at ~500 chars
  let output = "[Session Activity]\n" + summaries.join("\n");
  if (output.length > 500) {
    output = output.slice(0, 497) + "...";
  }
  return output;
}

export function readSessionLog(options: {
  jsonlPath: string;
  format: Format;
  lines?: number;
}): string {
  const maxLines = options.lines ?? 50;
  if (!existsSync(options.jsonlPath)) return "No session log found.";

  const content = readFileSync(options.jsonlPath, "utf-8");
  const allLines = content.split("\n").filter((l) => l.trim());
  const lines = allLines.slice(-maxLines);
  const entries = parseJsonlEntries(lines, options.format);

  const output: string[] = [];
  for (const entry of entries) {
    const ts = entry.timestamp ? `[${formatTimestamp(entry.timestamp)}]` : "";
    if (entry.role === "user" && entry.text) {
      output.push(`${ts} User: ${entry.text}`);
    } else if (entry.role === "assistant") {
      if (entry.text) {
        output.push(`${ts} Assistant: ${entry.text}`);
      }
      if (entry.toolUses) {
        for (const tool of entry.toolUses) {
          const arg = tool.primaryArg ? ` ${tool.primaryArg}` : "";
          output.push(`${ts} [${tool.name}${arg}]`);
        }
      }
    }
  }

  return output.length > 0 ? output.join("\n") : "No activity found.";
}

// --- JSONL Path Resolvers ---

export function resolveAgentSdkJsonl(
  sessionsDir: string,
  sessionName: string,
  cwd: string,
): string | null {
  const sessionFile = resolve(sessionsDir, `${sessionName}.json`);
  if (!existsSync(sessionFile)) return null;

  try {
    const data = JSON.parse(readFileSync(sessionFile, "utf-8"));
    const sessionId = data.sessionId;
    if (!sessionId) return null;

    const encoded = encodeCwd(cwd);
    const home = process.env.HOME || process.env.USERPROFILE || "";
    return resolve(home, ".claude", "projects", encoded, `${sessionId}.jsonl`);
  } catch {
    return null;
  }
}

export function encodeCwd(cwd: string): string {
  return cwd.replace(/\//g, "-").replace(/\./g, "-");
}

export function resolvePiJsonl(sessionsDir: string, sessionName: string): string | null {
  const sessionDir = resolve(sessionsDir, sessionName);
  if (!existsSync(sessionDir)) return null;

  try {
    const files = readdirSync(sessionDir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => ({
        name: f,
        mtime: statSync(resolve(sessionDir, f)).mtimeMs,
      }))
      .sort((a, b) => b.mtime - a.mtime);

    if (files.length === 0) return null;
    return resolve(sessionDir, files[0].name);
  } catch {
    return null;
  }
}

// --- Parsing ---

export function parseJsonlEntries(lines: string[], format: Format): ParsedEntry[] {
  const entries: ParsedEntry[] = [];

  for (const line of lines) {
    let parsed: any;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    if (format === "agent-sdk") {
      if (parsed.type === "user" && parsed.message?.role === "user") {
        const text = extractTextFromContent(parsed.message.content);
        if (text) entries.push({ role: "user", timestamp: parsed.timestamp, text });
      } else if (parsed.type === "assistant" && parsed.message?.role === "assistant") {
        const text = extractTextFromContent(parsed.message.content);
        const toolUses = extractToolUses(parsed.message.content, format);
        if (text || toolUses.length > 0) {
          entries.push({
            role: "assistant",
            timestamp: parsed.timestamp,
            text: text || undefined,
            toolUses,
          });
        }
      }
    } else {
      // pi format
      if (parsed.type === "message" && parsed.message?.role === "user") {
        const text = extractTextFromContent(parsed.message.content);
        if (text) entries.push({ role: "user", timestamp: parsed.timestamp, text });
      } else if (parsed.type === "message" && parsed.message?.role === "assistant") {
        const text = extractTextFromContent(parsed.message.content);
        const toolUses = extractToolUses(parsed.message.content, format);
        if (text || toolUses.length > 0) {
          entries.push({
            role: "assistant",
            timestamp: parsed.timestamp,
            text: text || undefined,
            toolUses,
          });
        }
      }
    }
  }

  return entries;
}

export function summarizeEntries(entries: ParsedEntry[]): SessionSummary | null {
  if (entries.length === 0) return null;

  let firstUserText = "";
  let lastAssistantText: string | undefined;
  const toolCounts = { edits: 0, reads: 0, commands: 0, other: 0 };
  let messageCount = 0;
  const timestamps: string[] = [];

  for (const entry of entries) {
    messageCount++;
    if (entry.timestamp) timestamps.push(entry.timestamp);

    if (entry.role === "user" && entry.text && !firstUserText) {
      firstUserText = entry.text;
    }

    if (entry.role === "assistant") {
      if (entry.text) lastAssistantText = entry.text;
      if (entry.toolUses) {
        for (const tool of entry.toolUses) {
          const cat = categorizeTool(tool.name);
          toolCounts[cat]++;
        }
      }
    }
  }

  return {
    firstUserText,
    toolCounts,
    messageCount,
    timeSpan: {
      first: timestamps[0],
      last: timestamps[timestamps.length - 1],
    },
    lastAssistantText,
  };
}

// --- Helpers ---

function extractTextFromContent(content: any[]): string | null {
  if (!Array.isArray(content)) return null;
  const texts: string[] = [];
  for (const part of content) {
    if (part.type === "text" && part.text) {
      texts.push(part.text);
    }
  }
  return texts.length > 0 ? texts.join("\n") : null;
}

function extractToolUses(content: any[], format: Format): { name: string; primaryArg?: string }[] {
  if (!Array.isArray(content)) return [];
  const tools: { name: string; primaryArg?: string }[] = [];

  for (const part of content) {
    const isToolUse = format === "agent-sdk" ? part.type === "tool_use" : part.type === "toolCall";

    if (isToolUse) {
      const name = part.name || "unknown";
      const input = format === "agent-sdk" ? part.input : part.arguments;
      const primaryArg = extractPrimaryArg(name, input);
      tools.push({ name, primaryArg });
    }
  }

  return tools;
}

function extractPrimaryArg(_name: string, input: any): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  // Common patterns for primary argument
  return (
    input.file_path || input.path || input.command || input.pattern || input.query || input.url
  );
}

function categorizeTool(name: string): "edits" | "reads" | "commands" | "other" {
  const lowerName = name.toLowerCase();
  if (["edit", "write", "notebookedit"].includes(lowerName)) return "edits";
  if (["read", "glob", "grep", "ls"].includes(lowerName)) return "reads";
  if (["bash", "exec", "execute_shell_command"].includes(lowerName)) return "commands";
  return "other";
}

function listSessionNames(sessionsDir: string, format: Format): string[] {
  if (!existsSync(sessionsDir)) return [];
  try {
    const entries = readdirSync(sessionsDir);
    if (format === "agent-sdk") {
      return entries.filter((e) => e.endsWith(".json")).map((e) => e.replace(/\.json$/, ""));
    }
    // pi: subdirectories
    return entries.filter((e) => {
      try {
        return statSync(resolve(sessionsDir, e)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

function loadCursors(cursorFile: string): CursorState {
  try {
    return JSON.parse(readFileSync(cursorFile, "utf-8"));
  } catch {
    return {};
  }
}

function saveCursors(cursorFile: string, cursors: CursorState): void {
  mkdirSync(dirname(cursorFile), { recursive: true });
  writeFileSync(cursorFile, JSON.stringify(cursors, null, 2));
}

function readBytesFrom(filePath: string, offset: number, length: number): string {
  const buf = Buffer.alloc(length);
  const fd = openSync(filePath, "r");
  try {
    readSync(fd, buf, 0, length, offset);
  } finally {
    closeSync(fd);
  }
  return buf.toString("utf-8");
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 3) + "...";
}

function formatTimeAgo(timestamp: string): string {
  const diff = Date.now() - new Date(timestamp).getTime();
  if (isNaN(diff) || diff < 0) return "just now";
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatTimestamp(timestamp: string): string {
  const d = new Date(timestamp);
  if (isNaN(d.getTime())) return timestamp;
  return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
}
