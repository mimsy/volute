import { spawn, type ChildProcess } from "child_process";
import { execSync } from "child_process";
import { existsSync, mkdirSync } from "fs";
import { resolve } from "path";
import {
  tool,
  query,
  type SDKUserMessage,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

// --- State maps ---

type WorktreeInfo = {
  path: string;
  branch: string;
};

type ClaudeSession = {
  push: (msg: SDKUserMessage) => void;
  stream: AsyncGenerator<SDKMessage>;
  abortController: AbortController;
};

type WorktreeServer = {
  process: ChildProcess;
  port: number;
  worktreeId: string;
};

const worktrees = new Map<string, WorktreeInfo>();
const claudeSessions = new Map<string, ClaudeSession>();
const worktreeServers = new Map<string, WorktreeServer>();

const projectRoot = process.cwd();

// --- Helpers ---

function generateId(): string {
  return Math.random().toString(36).slice(2, 10);
}

function createMessageChannel() {
  const queue: SDKUserMessage[] = [];
  let waiting: ((value: IteratorResult<SDKUserMessage>) => void) | null = null;

  return {
    push(msg: SDKUserMessage) {
      if (waiting) {
        const r = waiting;
        waiting = null;
        r({ value: msg, done: false });
      } else {
        queue.push(msg);
      }
    },
    iterable: {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<SDKUserMessage>> {
            if (queue.length > 0) {
              return Promise.resolve({ value: queue.shift()!, done: false });
            }
            return new Promise((r) => {
              waiting = r;
            });
          },
        };
      },
    },
  };
}

// --- Tool definitions ---

export const createWorktree = tool(
  "create_worktree",
  "Create a git worktree under .worktrees/ with a new branch. Runs bun install in the worktree. Returns worktree ID and path.",
  {
    branch: z.string().describe("Branch name to create"),
  },
  async ({ branch }) => {
    const id = generateId();
    const worktreeDir = resolve(projectRoot, ".worktrees", id);
    const parentDir = resolve(projectRoot, ".worktrees");

    if (!existsSync(parentDir)) {
      mkdirSync(parentDir, { recursive: true });
    }

    try {
      execSync(`git worktree add -b ${branch} ${worktreeDir}`, {
        cwd: projectRoot,
        stdio: "pipe",
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return { content: [{ type: "text" as const, text: `Failed to create worktree: ${msg}` }], isError: true };
    }

    try {
      execSync("bun install", { cwd: worktreeDir, stdio: "pipe" });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return { content: [{ type: "text" as const, text: `Worktree created but bun install failed: ${msg}` }], isError: true };
    }

    worktrees.set(id, { path: worktreeDir, branch });

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ id, path: worktreeDir, branch }),
        },
      ],
    };
  },
);

export const startClaudeSession = tool(
  "start_claude_session",
  "Start an interactive Claude Code session with cwd in a worktree. Returns session_id for use with send_to_claude_session.",
  {
    worktree_id: z.string().describe("ID of the worktree to use as cwd"),
  },
  async ({ worktree_id }) => {
    const wt = worktrees.get(worktree_id);
    if (!wt) {
      return { content: [{ type: "text" as const, text: `Unknown worktree: ${worktree_id}` }], isError: true };
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
        cwd: wt.path,
        abortController,
      },
    });

    claudeSessions.set(sessionId, {
      push: channel.push,
      stream,
      abortController,
    });

    return {
      content: [
        { type: "text" as const, text: JSON.stringify({ session_id: sessionId, worktree_path: wt.path }) },
      ],
    };
  },
);

export const sendToClaudeSession = tool(
  "send_to_claude_session",
  "Send a message to a Claude Code session and wait for the assistant's response.",
  {
    session_id: z.string().describe("Session ID from start_claude_session"),
    message: z.string().describe("Message to send to Claude"),
  },
  async ({ session_id, message }) => {
    const session = claudeSessions.get(session_id);
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

    // Drain stream until we get a result message
    const textParts: string[] = [];
    for await (const msg of session.stream) {
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

    return {
      content: [
        { type: "text" as const, text: textParts.join("\n") || "(no text response)" },
      ],
    };
  },
);

export const endClaudeSession = tool(
  "end_claude_session",
  "End a Claude Code session.",
  {
    session_id: z.string().describe("Session ID to end"),
  },
  async ({ session_id }) => {
    const session = claudeSessions.get(session_id);
    if (!session) {
      return { content: [{ type: "text" as const, text: `Unknown session: ${session_id}` }], isError: true };
    }

    session.abortController.abort();
    claudeSessions.delete(session_id);

    return {
      content: [{ type: "text" as const, text: `Session ${session_id} ended.` }],
    };
  },
);

export const startWorktreeServer = tool(
  "start_worktree_server",
  "Start the molt server in a worktree on a given port. Waits for it to be listening.",
  {
    worktree_id: z.string().describe("ID of the worktree"),
    port: z.number().describe("Port number for the server"),
  },
  async ({ worktree_id, port }) => {
    const wt = worktrees.get(worktree_id);
    if (!wt) {
      return { content: [{ type: "text" as const, text: `Unknown worktree: ${worktree_id}` }], isError: true };
    }

    const serverId = generateId();

    const child = spawn("bun", ["run", "src/server.ts", "--port", String(port)], {
      cwd: wt.path,
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Wait for "listening on" in stdout
    const ready = await new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => resolve(false), 15000);

      child.stdout?.on("data", (data: Buffer) => {
        if (data.toString().includes("listening on")) {
          clearTimeout(timeout);
          resolve(true);
        }
      });

      child.on("error", () => {
        clearTimeout(timeout);
        resolve(false);
      });

      child.on("exit", () => {
        clearTimeout(timeout);
        resolve(false);
      });
    });

    if (!ready) {
      child.kill();
      return { content: [{ type: "text" as const, text: "Server failed to start within timeout" }], isError: true };
    }

    worktreeServers.set(serverId, { process: child, port, worktreeId: worktree_id });

    return {
      content: [
        { type: "text" as const, text: JSON.stringify({ server_id: serverId, port }) },
      ],
    };
  },
);

export const sendToWorktreeServer = tool(
  "send_to_worktree_server",
  "Send a message to a running worktree server and collect the response. Connects via SSE and POST /message.",
  {
    server_id: z.string().describe("Server ID from start_worktree_server"),
    message: z.string().describe("Message to send"),
  },
  async ({ server_id, message }) => {
    const server = worktreeServers.get(server_id);
    if (!server) {
      return { content: [{ type: "text" as const, text: `Unknown server: ${server_id}` }], isError: true };
    }

    const baseUrl = `http://localhost:${server.port}`;
    const parts: string[] = [];

    // Connect SSE first
    const sseResponse = await fetch(`${baseUrl}/events`);
    const reader = sseResponse.body?.getReader();
    if (!reader) {
      return { content: [{ type: "text" as const, text: "Failed to connect SSE" }], isError: true };
    }

    // Send the message
    await fetch(`${baseUrl}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: message }),
    });

    // Read SSE events with inactivity timeout
    const decoder = new TextDecoder();
    let buffer = "";
    const inactivityMs = 30000;

    try {
      while (true) {
        const readPromise = reader.read();
        const timeoutPromise = new Promise<{ done: true; value: undefined }>((resolve) =>
          setTimeout(() => resolve({ done: true, value: undefined }), inactivityMs),
        );

        const { done, value } = await Promise.race([readPromise, timeoutPromise]);
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            try {
              const data = JSON.parse(line.slice(6));
              if (data.role === "assistant" && data.content) {
                parts.push(data.content);
              }
            } catch {
              // skip non-JSON lines (keepalive comments, etc.)
            }
          }
        }
      }
    } finally {
      reader.cancel().catch(() => {});
    }

    return {
      content: [
        { type: "text" as const, text: parts.join("\n") || "(no response received)" },
      ],
    };
  },
);

export const cleanupWorktree = tool(
  "cleanup_worktree",
  "Kill any running server in the worktree, remove the worktree, and clean up all associated state.",
  {
    worktree_id: z.string().describe("ID of the worktree to clean up"),
  },
  async ({ worktree_id }) => {
    const wt = worktrees.get(worktree_id);
    if (!wt) {
      return { content: [{ type: "text" as const, text: `Unknown worktree: ${worktree_id}` }], isError: true };
    }

    // Kill any servers in this worktree
    for (const [id, server] of worktreeServers) {
      if (server.worktreeId === worktree_id) {
        server.process.kill();
        worktreeServers.delete(id);
      }
    }

    // End any claude sessions (they reference worktree paths)
    // (sessions don't track worktree_id directly, so we skip this)

    // Remove the git worktree
    try {
      execSync(`git worktree remove --force ${wt.path}`, {
        cwd: projectRoot,
        stdio: "pipe",
      });
    } catch {
      // Best effort
    }

    // Delete the branch
    try {
      execSync(`git branch -D ${wt.branch}`, {
        cwd: projectRoot,
        stdio: "pipe",
      });
    } catch {
      // Best effort
    }

    worktrees.delete(worktree_id);

    return {
      content: [{ type: "text" as const, text: `Worktree ${worktree_id} cleaned up.` }],
    };
  },
);

// --- All tools array ---

export const selfModifyTools = [
  createWorktree,
  startClaudeSession,
  sendToClaudeSession,
  endClaudeSession,
  startWorktreeServer,
  sendToWorktreeServer,
  cleanupWorktree,
];

// --- Cleanup ---

export function cleanupAll() {
  for (const [, session] of claudeSessions) {
    session.abortController.abort();
  }
  claudeSessions.clear();

  for (const [, server] of worktreeServers) {
    server.process.kill();
  }
  worktreeServers.clear();

  for (const [, wt] of worktrees) {
    try {
      execSync(`git worktree remove --force ${wt.path}`, {
        cwd: projectRoot,
        stdio: "pipe",
      });
    } catch {
      // Best effort
    }
    try {
      execSync(`git branch -D ${wt.branch}`, {
        cwd: projectRoot,
        stdio: "pipe",
      });
    } catch {
      // Best effort
    }
  }
  worktrees.clear();
}
