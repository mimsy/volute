import { createSessionManager } from "./lib/agent-sessions.js";
import { formatPrefix } from "./lib/format-prefix.js";
import { createAutoCommitHook } from "./lib/hooks/auto-commit.js";
import { createIdentityReloadHook } from "./lib/hooks/identity-reload.js";
import { logMessage } from "./lib/logger.js";
import type { ChannelMeta, Listener, VoluteContentPart } from "./lib/types.js";

export function createAgent(options: {
  systemPrompt: string;
  cwd: string;
  abortController: AbortController;
  model?: string;
  sessionsDir: string;
  onIdentityReload?: () => Promise<void>;
}) {
  const autoCommit = createAutoCommitHook(options.cwd);
  const identityReload = createIdentityReloadHook(options.cwd);

  const sessionManager = createSessionManager({
    systemPrompt: options.systemPrompt,
    cwd: options.cwd,
    abortController: options.abortController,
    model: options.model,
    sessionsDir: options.sessionsDir,
    postToolUseHooks: [{ matcher: "Edit|Write", hooks: [autoCommit.hook, identityReload.hook] }],
    onTurnDone: () => {
      if (identityReload.needsReload()) {
        options.onIdentityReload?.();
      }
    },
  });

  function sendMessage(content: string | VoluteContentPart[], meta?: ChannelMeta) {
    const sessionName = meta?.sessionName ?? "main";
    const session = sessionManager.getOrCreateSession(sessionName);

    const text =
      typeof content === "string"
        ? content
        : content.map((p) => (p.type === "text" ? p.text : `[${p.type}]`)).join(" ");
    logMessage("in", text, meta?.channel);

    const time = new Date().toLocaleString();
    const prefix = formatPrefix(meta, time);

    let sdkContent: (
      | { type: "text"; text: string }
      | {
          type: "image";
          source: {
            type: "base64";
            media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
            data: string;
          };
        }
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
            media_type: part.media_type as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
            data: part.data,
          },
        };
      });
      if (prefix && !hasText) {
        sdkContent.unshift({ type: "text" as const, text: prefix.trimEnd() });
      }
    }

    session.channel.push({
      type: "user",
      session_id: "",
      message: {
        role: "user",
        content: sdkContent,
      },
      parent_tool_use_id: null,
    });
  }

  function onMessage(listener: Listener, sessionName?: string): () => void {
    const name = sessionName ?? "main";
    const session = sessionManager.getOrCreateSession(name);
    session.listeners.add(listener);
    return () => session.listeners.delete(listener);
  }

  return { sendMessage, onMessage, waitForCommits: autoCommit.waitForCommits };
}
