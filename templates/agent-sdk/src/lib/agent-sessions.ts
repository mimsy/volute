import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { createPreCompactHook } from "./hooks/pre-compact.js";
import { log, logText, logThinking, logToolUse } from "./logger.js";
import { createMessageChannel } from "./message-channel.js";
import type { Listener, VoluteEvent } from "./types.js";

type Session = {
  name: string;
  channel: ReturnType<typeof createMessageChannel>;
  listeners: Set<Listener>;
};

export function createSessionManager(options: {
  systemPrompt: string;
  cwd: string;
  abortController: AbortController;
  model?: string;
  sessionsDir: string;
  postToolUseHooks: { matcher: string; hooks: HookCallback[] }[];
  onTurnDone?: () => void;
  compactionMessage?: string;
}) {
  const sessions = new Map<string, Session>();
  const compactionMessage =
    options.compactionMessage ??
    "Conversation is about to be compacted. Please update today's daily log with a summary of what we've discussed and accomplished so far, so context is preserved before compaction.";

  function sessionFilePath(sessionName: string): string {
    return resolve(options.sessionsDir, `${sessionName}.json`);
  }

  function loadSessionId(sessionName: string): string | undefined {
    try {
      const data = JSON.parse(readFileSync(sessionFilePath(sessionName), "utf-8"));
      return data.sessionId;
    } catch {
      return undefined;
    }
  }

  function saveSessionId(sessionName: string, sessionId: string) {
    mkdirSync(options.sessionsDir, { recursive: true });
    writeFileSync(sessionFilePath(sessionName), JSON.stringify({ sessionId }));
  }

  function deleteSessionId(sessionName: string) {
    try {
      const path = sessionFilePath(sessionName);
      if (existsSync(path)) unlinkSync(path);
    } catch (err) {
      log("agent", `failed to delete session file for "${sessionName}":`, err);
    }
  }

  function broadcastToSession(session: Session, event: VoluteEvent) {
    for (const listener of session.listeners) {
      try {
        listener(event);
      } catch (err) {
        log("agent", "listener threw during broadcast:", err);
      }
    }
  }

  function createStream(session: Session, resume?: string) {
    const preCompact = createPreCompactHook(() => {
      session.channel.push({
        type: "user",
        session_id: "",
        message: {
          role: "user",
          content: [{ type: "text", text: compactionMessage }],
        },
        parent_tool_use_id: null,
      });
    });

    return query({
      prompt: session.channel.iterable,
      options: {
        systemPrompt: options.systemPrompt,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        settingSources: ["project"],
        cwd: options.cwd,
        abortController: options.abortController,
        model: options.model,
        resume,
        hooks: {
          PostToolUse: options.postToolUseHooks,
          PreCompact: [{ hooks: [preCompact.hook] }],
        },
      },
    });
  }

  async function consumeStream(stream: ReturnType<typeof query>, session: Session) {
    for await (const msg of stream) {
      if ("session_id" in msg && msg.session_id) {
        if (!session.name.startsWith("new-")) {
          saveSessionId(session.name, msg.session_id as string);
        }
      }
      if (msg.type === "assistant") {
        for (const b of msg.message.content) {
          if (b.type === "thinking" && "thinking" in b && b.thinking) {
            logThinking(b.thinking as string);
          } else if (b.type === "text") {
            const text = (b as { text: string }).text;
            logText(text);
            broadcastToSession(session, { type: "text", content: text });
          } else if (b.type === "tool_use") {
            const tb = b as { name: string; input: unknown };
            logToolUse(tb.name, tb.input);
            broadcastToSession(session, { type: "tool_use", name: tb.name, input: tb.input });
          }
        }
      }
      if (msg.type === "result") {
        log("agent", `session "${session.name}": turn done`);
        broadcastToSession(session, { type: "done" });
        options.onTurnDone?.();
      }
    }
  }

  function startSession(session: Session, savedSessionId?: string) {
    (async () => {
      log("agent", `session "${session.name}": stream consumer started`);
      try {
        await consumeStream(createStream(session, savedSessionId), session);
      } catch (err) {
        if (savedSessionId) {
          log("agent", `session "${session.name}": resume failed, starting fresh:`, err);
          deleteSessionId(session.name);
          try {
            await consumeStream(createStream(session), session);
          } catch (retryErr) {
            log("agent", `session "${session.name}": stream consumer error:`, retryErr);
            broadcastToSession(session, { type: "done" });
            sessions.delete(session.name);
          }
        } else {
          log("agent", `session "${session.name}": stream consumer error:`, err);
          broadcastToSession(session, { type: "done" });
          sessions.delete(session.name);
        }
      }
      log("agent", `session "${session.name}": stream consumer ended`);
    })();
  }

  function getOrCreateSession(name: string): Session {
    const existing = sessions.get(name);
    if (existing) return existing;

    const session: Session = {
      name,
      channel: createMessageChannel(),
      listeners: new Set(),
    };
    sessions.set(name, session);

    const isEphemeral = name.startsWith("new-");
    const savedSessionId = isEphemeral ? undefined : loadSessionId(name);
    if (savedSessionId) {
      log("agent", `session "${name}": resuming ${savedSessionId}`);
    } else {
      log("agent", `session "${name}": starting fresh`);
    }

    startSession(session, savedSessionId);
    return session;
  }

  return { getOrCreateSession };
}
