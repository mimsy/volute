import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from "fs";
import { resolve } from "path";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { log } from "./logger.js";

const projectRoot = process.cwd();
const memoryPath = resolve(projectRoot, "home/MEMORY.md");
const memoryDir = resolve(projectRoot, "home/memory");

function todayString(): string {
  return new Date().toISOString().slice(0, 10);
}

function dailyLogPath(date: string): string {
  return resolve(memoryDir, `${date}.md`);
}

function ensureMemoryDir() {
  if (!existsSync(memoryDir)) {
    mkdirSync(memoryDir, { recursive: true });
  }
}

function loadFile(path: string): string {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}

/** Get sorted list of daily log filenames (YYYY-MM-DD.md) */
export function listDailyLogs(): string[] {
  try {
    return readdirSync(memoryDir)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .sort();
  } catch {
    return [];
  }
}

/** Load the most recent N daily logs, returning their contents with date headers */
export function loadRecentDailyLogs(count: number): string {
  const logs = listDailyLogs();
  const recent = logs.slice(-count);
  const parts: string[] = [];
  for (const filename of recent) {
    const date = filename.replace(".md", "");
    const content = loadFile(resolve(memoryDir, filename));
    if (content.trim()) {
      parts.push(`### ${date}\n\n${content.trim()}`);
    }
  }
  return parts.join("\n\n");
}

export const readMemory = tool(
  "read_memory",
  "Read the contents of MEMORY.md (long-term memory).",
  {},
  async () => {
    const content = loadFile(memoryPath);
    return { content: [{ type: "text" as const, text: content || "(empty)" }] };
  },
);

export const writeMemory = tool(
  "write_memory",
  "Overwrite MEMORY.md with new content. Use this to reorganize or consolidate long-term memory.",
  {
    content: z.string().describe("New content for MEMORY.md"),
  },
  async ({ content }) => {
    log("memory", "write_memory: updating MEMORY.md");
    writeFileSync(memoryPath, content);
    return { content: [{ type: "text" as const, text: "MEMORY.md updated." }] };
  },
);

export const readDailyLog = tool(
  "read_daily_log",
  "Read a daily log file. Defaults to today's log.",
  {
    date: z
      .string()
      .optional()
      .describe("Date in YYYY-MM-DD format (defaults to today)"),
  },
  async ({ date }) => {
    const d = date || todayString();
    const content = loadFile(dailyLogPath(d));
    return {
      content: [{ type: "text" as const, text: content || `(no log for ${d})` }],
    };
  },
);

export const writeDailyLog = tool(
  "write_daily_log",
  "Write or overwrite today's daily log.",
  {
    content: z.string().describe("Content for today's daily log"),
  },
  async ({ content }) => {
    const d = todayString();
    log("memory", `write_daily_log: updating ${d}`);
    ensureMemoryDir();
    writeFileSync(dailyLogPath(d), content);
    return { content: [{ type: "text" as const, text: `Daily log ${d} updated.` }] };
  },
);

export const consolidateMemory = tool(
  "consolidate_memory",
  "Read all daily logs older than N days. Review them and use write_memory to promote important information to long-term memory, then delete old logs.",
  {
    days: z
      .number()
      .optional()
      .describe("Include logs older than this many days (default: 3)"),
  },
  async ({ days }) => {
    const threshold = days ?? 3;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - threshold);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    const logs = listDailyLogs();
    const oldLogs = logs.filter((f) => f.replace(".md", "") <= cutoffStr);

    if (oldLogs.length === 0) {
      return {
        content: [{ type: "text" as const, text: "No daily logs older than " + threshold + " days." }],
      };
    }

    const parts: string[] = [];
    for (const filename of oldLogs) {
      const date = filename.replace(".md", "");
      const content = loadFile(resolve(memoryDir, filename));
      if (content.trim()) {
        parts.push(`### ${date}\n\n${content.trim()}`);
      }
    }

    const currentMemory = loadFile(memoryPath);

    return {
      content: [
        {
          type: "text" as const,
          text: [
            `Found ${oldLogs.length} daily log(s) older than ${threshold} days.`,
            "",
            "## Current MEMORY.md",
            currentMemory || "(empty)",
            "",
            "## Old daily logs",
            parts.join("\n\n") || "(all empty)",
            "",
            "Review the above. Use write_memory to update MEMORY.md with anything worth keeping, then delete the old log files.",
          ].join("\n"),
        },
      ],
    };
  },
);

export const memoryTools = [
  readMemory,
  writeMemory,
  readDailyLog,
  writeDailyLog,
  consolidateMemory,
];
