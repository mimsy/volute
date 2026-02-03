import { spawn } from "child_process";
import { appendFileSync, mkdirSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";
import {
  tool,
  query,
  type SDKUserMessage,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { log } from "./logger.js";
import { createMessageChannel } from "./message-channel.js";

// --- State ---

const projectRoot = process.cwd();

type ClaudeCodeSession = {
  push: (msg: SDKUserMessage) => void;
  stream: AsyncGenerator<SDKMessage>;
  abortController: AbortController;
};

const claudeCodeSessions = new Map<string, ClaudeCodeSession>();

function generateId(): string {
  return Math.random().toString(36).slice(2, 10);
}

function moltExecAsync(args: string[], cwd?: string): Promise<string> {
  log("tools", `exec async: molt ${args.join(" ")}`);
  return new Promise((resolve, reject) => {
    const child = spawn("molt", args, {
      cwd: cwd ?? projectRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];

    child.stdout?.on("data", (data: Buffer) => chunks.push(data));
    child.stderr?.on("data", (data: Buffer) => errChunks.push(data));

    child.on("error", reject);
    child.on("close", (code) => {
      const stdout = Buffer.concat(chunks).toString("utf-8");
      if (code === 0) {
        resolve(stdout);
      } else {
        const stderr = Buffer.concat(errChunks).toString("utf-8");
        reject(new Error(stderr || stdout || `molt exited with code ${code}`));
      }
    });
  });
}

// --- Thin wrappers around molt CLI ---

export const createVariant = tool(
  "create_variant",
  "Create a variant: git worktree + server. Optionally customize personality with a soul. Returns variant info including port.",
  {
    name: z.string().describe("Variant name (also used as branch name)"),
    soul: z.string().optional().describe("Content for SOUL.md to customize the variant's personality"),
  },
  async ({ name, soul }) => {
    log("tools", `create_variant: name=${name} soul=${soul ? "yes" : "no"}`);
    try {
      const args = ["fork", name, "--json"];
      if (soul) args.push("--soul", soul);
      const result = await moltExecAsync(args);
      return { content: [{ type: "text" as const, text: result }] };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return { content: [{ type: "text" as const, text: msg }], isError: true };
    }
  },
);

export const sendToVariant = tool(
  "send_to_variant",
  "Send a message to a running variant server and get the response. The variant maintains conversation history across calls.",
  {
    port: z.number().describe("Port of the variant server"),
    message: z.string().describe("Message to send"),
  },
  async ({ port, message }) => {
    log("tools", `send_to_variant: port=${port} msg=${message.slice(0, 80)}`);
    try {
      const result = await moltExecAsync(["send", "--port", String(port), message]);
      return { content: [{ type: "text" as const, text: result || "(no response)" }] };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return { content: [{ type: "text" as const, text: msg }], isError: true };
    }
  },
);

export const listVariants = tool(
  "list_variants",
  "List all active variants with their ports, status, and branches.",
  {},
  async () => {
    try {
      const result = await moltExecAsync(["variants", "--json"]);
      return { content: [{ type: "text" as const, text: result }] };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return { content: [{ type: "text" as const, text: msg }], isError: true };
    }
  },
);

export const mergeVariant = tool(
  "merge_variant",
  "Merge a variant branch back into the main branch and restart. Appends context to MEMORY.md for continuity. This will exit the process — the supervisor will complete the merge and restart.",
  {
    name: z.string().describe("Name of the variant to merge"),
    summary: z.string().describe("Brief summary of what changes the variant made"),
    justification: z.string().describe("Why this variant should be merged"),
    memory: z.string().describe("Additional context to remember after restart"),
  },
  async ({ name, summary, justification, memory }) => {
    log("tools", `merge_variant: name=${name}`);

    // Append structured context to MEMORY.md
    const memoryPath = resolve(projectRoot, "MEMORY.md");
    const timestamp = new Date().toISOString();
    const entry = [
      `\n## ${timestamp} — Merged variant: ${name}`,
      `\n**Why:** ${justification}`,
      `\n**Changes:** ${summary}`,
      `\n**Context:** ${memory}\n`,
    ].join("\n");
    appendFileSync(memoryPath, entry);
    log("tools", `merge_variant: appended to MEMORY.md`);

    // Write restart signal for supervisor
    const moltDir = resolve(projectRoot, ".molt");
    if (!existsSync(moltDir)) {
      mkdirSync(moltDir, { recursive: true });
    }
    writeFileSync(
      resolve(moltDir, "restart.json"),
      JSON.stringify({ action: "merge", name }),
    );
    log("tools", `merge_variant: wrote .molt/restart.json`);

    // Clean up Claude Code sessions
    cleanupAll();

    // Exit — supervisor picks it up
    process.exit(0);
  },
);

export const updateWorktreeSoul = tool(
  "update_worktree_soul",
  "Update SOUL.md in a variant's worktree. If the variant has a running server, you should restart it by creating a new variant.",
  {
    name: z.string().describe("Variant name"),
    soul: z.string().describe("New content for SOUL.md"),
  },
  async ({ name, soul }) => {
    log("tools", `update_worktree_soul: name=${name}`);
    try {
      const result = await moltExecAsync(["variants", "--json"]);
      const variants = JSON.parse(result);
      const variant = variants.find((v: { name: string }) => v.name === name);
      if (!variant) {
        return { content: [{ type: "text" as const, text: `Unknown variant: ${name}` }], isError: true };
      }
      writeFileSync(resolve(variant.path, "SOUL.md"), soul);
      return { content: [{ type: "text" as const, text: `SOUL.md updated for variant ${name}.` }] };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return { content: [{ type: "text" as const, text: msg }], isError: true };
    }
  },
);

// --- Claude Code session tools (kept as-is, no CLI equivalent) ---

export const startClaudeCodeSession = tool(
  "start_claude_code_session",
  "Start a Claude Code coding assistant session in a variant's worktree to make code changes. Returns session_id for use with send_to_claude_code_session.",
  {
    name: z.string().describe("Variant name to use as cwd"),
  },
  async ({ name }) => {
    log("tools", `start_claude_code_session: name=${name}`);
    try {
      const result = await moltExecAsync(["variants", "--json"]);
      const variants = JSON.parse(result);
      const variant = variants.find((v: { name: string }) => v.name === name);
      if (!variant) {
        return { content: [{ type: "text" as const, text: `Unknown variant: ${name}` }], isError: true };
      }

      const sessionId = generateId();
      const abortController = new AbortController();
      const channel = createMessageChannel();

      const stream = query({
        prompt: channel.iterable,
        options: {
          systemPrompt: "You are a coding assistant. You are working in a git worktree. Make the requested changes.",
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          cwd: variant.path,
          abortController,
        },
      });

      claudeCodeSessions.set(sessionId, {
        push: channel.push,
        stream,
        abortController,
      });

      log("tools", `start_claude_code_session: created session=${sessionId}`);
      return {
        content: [
          { type: "text" as const, text: JSON.stringify({ session_id: sessionId, worktree_path: variant.path }) },
        ],
      };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return { content: [{ type: "text" as const, text: msg }], isError: true };
    }
  },
);

export const sendToClaudeCodeSession = tool(
  "send_to_claude_code_session",
  "Send a message to a Claude Code session and wait for the assistant's response.",
  {
    session_id: z.string().describe("Session ID from start_claude_code_session"),
    message: z.string().describe("Message to send to Claude"),
  },
  async ({ session_id, message }) => {
    log("tools", `send_to_claude_code_session: session=${session_id} msg=${message.slice(0, 80)}`);
    const session = claudeCodeSessions.get(session_id);
    if (!session) {
      return { content: [{ type: "text" as const, text: `Unknown session: ${session_id}` }], isError: true };
    }

    session.push({
      type: "user",
      session_id: "",
      message: {
        role: "user",
        content: [{ type: "text", text: message }],
      },
      parent_tool_use_id: null,
    });

    const textParts: string[] = [];
    try {
      while (true) {
        const { value: msg, done } = await session.stream.next();
        if (done) break;
        if (msg.type === "assistant") {
          const text = msg.message.content
            .filter((b: { type: string }) => b.type === "text")
            .map((b: { text: string }) => b.text)
            .join("");
          if (text) textParts.push(text);
        }
        if (msg.type === "result") {
          break;
        }
      }
    } catch (err) {
      log("tools", `send_to_claude_code_session: stream error for session=${session_id}:`, err);
    }

    log("tools", `send_to_claude_code_session: done session=${session_id} parts=${textParts.length}`);
    return {
      content: [
        { type: "text" as const, text: textParts.join("\n") || "(no text response)" },
      ],
    };
  },
);

export const endClaudeCodeSession = tool(
  "end_claude_code_session",
  "End a Claude Code session.",
  {
    session_id: z.string().describe("Session ID to end"),
  },
  async ({ session_id }) => {
    log("tools", `end_claude_code_session: session=${session_id}`);
    const session = claudeCodeSessions.get(session_id);
    if (!session) {
      return { content: [{ type: "text" as const, text: `Unknown session: ${session_id}` }], isError: true };
    }

    session.abortController.abort();
    claudeCodeSessions.delete(session_id);

    return {
      content: [{ type: "text" as const, text: `Session ${session_id} ended.` }],
    };
  },
);

// --- All tools array ---

export const selfModifyTools = [
  createVariant,
  listVariants,
  sendToVariant,
  mergeVariant,
  updateWorktreeSoul,
  startClaudeCodeSession,
  sendToClaudeCodeSession,
  endClaudeCodeSession,
];

// --- Cleanup ---

export function cleanupAll() {
  log("cleanup", `aborting ${claudeCodeSessions.size} sessions`);

  for (const [, session] of claudeCodeSessions) {
    session.abortController.abort();
  }
  claudeCodeSessions.clear();
}
