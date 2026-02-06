import { type HookCallback, query } from "@anthropic-ai/claude-agent-sdk";
import { commitFileChange } from "./auto-commit.js";
import { log, logMessage, logText, logThinking, logToolResult, logToolUse } from "./logger.js";
import { createMessageChannel } from "./message-channel.js";
import type { VoluteContentPart, VoluteEvent } from "./types.js";

type Listener = (event: VoluteEvent) => void;

export function createAgent(options: {
  systemPrompt: string;
  cwd: string;
  abortController: AbortController;
  model?: string;
  resume?: string;
  onSessionId?: (id: string) => void;
  onStreamError?: (err: unknown) => void;
  onCompact?: () => void;
}) {
  const channel = createMessageChannel();
  const listeners = new Set<Listener>();

  // Hook to auto-commit file changes in home/
  const autoCommitHook: HookCallback = async (input) => {
    const filePath = (input as { tool_input?: { file_path?: string } }).tool_input?.file_path;
    if (filePath) {
      commitFileChange(filePath, options.cwd);
    }
    return {};
  };

  // Block compaction once so the agent can update its daily log with full context
  let compactBlocked = false;
  const preCompactHook: HookCallback = async () => {
    if (!compactBlocked) {
      compactBlocked = true;
      log("agent", "blocking compaction — asking agent to update daily log first");
      if (options.onCompact) options.onCompact();
      return { decision: "block" };
    }
    compactBlocked = false;
    log("agent", "allowing compaction");
    return {};
  };

  const stream = query({
    prompt: channel.iterable,
    options: {
      systemPrompt: options.systemPrompt,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      cwd: options.cwd,
      abortController: options.abortController,
      model: options.model,
      resume: options.resume,
      hooks: {
        PostToolUse: [{ matcher: "Edit|Write", hooks: [autoCommitHook] }],
        PreCompact: [{ hooks: [preCompactHook] }],
      },
    },
  });

  function broadcast(event: VoluteEvent) {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch (err) {
        log("agent", "listener threw during broadcast:", err);
      }
    }
  }

  // Consume the SDK stream and broadcast VoluteEvent events
  (async () => {
    log("agent", "stream consumer started");
    try {
      for await (const msg of stream) {
        if ("session_id" in msg && msg.session_id && options.onSessionId) {
          options.onSessionId(msg.session_id as string);
        }
        if (msg.type === "assistant") {
          for (const b of msg.message.content) {
            if (b.type === "thinking" && "thinking" in b && b.thinking) {
              logThinking(b.thinking as string);
            } else if (b.type === "text") {
              const text = (b as { text: string }).text;
              logText(text);
              broadcast({ type: "text", content: text });
            } else if (b.type === "tool_use") {
              const tb = b as { name: string; input: unknown };
              logToolUse(tb.name, tb.input);
              broadcast({ type: "tool_use", name: tb.name, input: tb.input });
            } else if (b.type === "image" && "source" in b) {
              const src = b.source as { type: string; media_type: string; data: string };
              if (src.type === "base64") {
                log("agent", "image:", src.media_type, `${src.data.length} bytes`);
                broadcast({ type: "image", media_type: src.media_type, data: src.data });
              }
            }
          }
        }
        if (msg.type === "tool_result") {
          const tr = msg as { name?: string; content?: string; is_error?: boolean };
          const output = tr.content ?? "";
          logToolResult(tr.name ?? "unknown", output, tr.is_error);
          broadcast({ type: "tool_result", output, is_error: tr.is_error });
        }
        if (msg.type === "result") {
          log("agent", "turn done");
          broadcast({ type: "done" });
        }
      }
    } catch (err) {
      log("agent", "stream consumer error:", err);
      if (options.onStreamError) options.onStreamError(err);
      process.exit(1);
    }
    log("agent", "stream consumer ended");
  })();

  function sendMessage(content: string | VoluteContentPart[], source?: string, sender?: string) {
    const text =
      typeof content === "string"
        ? content
        : content.map((p) => (p.type === "text" ? p.text : `[${p.type}]`)).join(" ");
    logMessage("in", text, source);

    // Build context prefix from channel/sender metadata
    const prefix = source && sender ? `[${source}: ${sender}]\n` : "";

    let sdkContent: (
      | { type: "text"; text: string }
      | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
    )[];

    if (typeof content === "string") {
      sdkContent = [{ type: "text" as const, text: prefix + content }];
    } else {
      const hasText = content.some((p) => p.type === "text");
      sdkContent = content.map((part, i) => {
        if (part.type === "text") {
          return { type: "text" as const, text: (i === 0 ? prefix : "") + part.text };
        }
        return {
          type: "image" as const,
          source: {
            type: "base64" as const,
            media_type: part.media_type,
            data: part.data,
          },
        };
      });
      // If no text parts but we have a prefix, prepend a text part
      if (prefix && !hasText) {
        sdkContent.unshift({ type: "text" as const, text: prefix.trimEnd() });
      }
    }

    channel.push({
      type: "user",
      session_id: "",
      message: {
        role: "user",
        content: sdkContent,
      },
      parent_tool_use_id: null,
    });
  }

  function onMessage(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  return { sendMessage, onMessage };
}
