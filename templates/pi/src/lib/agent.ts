import { getModel, getModels, type ImageContent } from "@mariozechner/pi-ai";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionFactory,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";
import { commitFileChange } from "./auto-commit.js";
import { log, logMessage, logText, logThinking, logToolResult, logToolUse } from "./logger.js";
import type { ChannelMeta, VoluteContentPart, VoluteEvent } from "./types.js";

type Listener = (event: VoluteEvent) => void;

function formatPrefix(meta: ChannelMeta | undefined): string {
  if (!meta?.channel && !meta?.sender) return "";
  const platform =
    meta.platform ??
    (() => {
      const n = (meta.channel ?? "").split(":")[0];
      return n.charAt(0).toUpperCase() + n.slice(1);
    })();
  let sender = meta.sender ?? "";
  if (meta.isDM) {
    sender += " in DM";
  } else if (meta.channelName) {
    sender += ` in #${meta.channelName}`;
    if (meta.guildName) sender += ` in ${meta.guildName}`;
  }
  const parts = [platform, sender].filter(Boolean);
  return parts.length > 0 ? `[${parts.join(": ")}]\n` : "";
}

export async function createAgent(options: {
  systemPrompt: string;
  cwd: string;
  model?: string;
  resume?: boolean;
  onCompact?: () => void;
}) {
  const listeners = new Set<Listener>();

  // Block compaction once so the agent can update its daily log with full context
  let compactBlocked = false;
  const preCompactExtension: ExtensionFactory = (pi) => {
    pi.on("session_before_compact", () => {
      if (!compactBlocked) {
        compactBlocked = true;
        log("agent", "blocking compaction — asking agent to update daily log first");
        if (options.onCompact) options.onCompact();
        return { cancel: true };
      }
      compactBlocked = false;
      log("agent", "allowing compaction");
    });
  };

  // Parse model string: "provider:model-id" or use default
  const modelStr = options.model || process.env.PI_MODEL || "anthropic:claude-sonnet-4-20250514";
  const [provider, ...rest] = modelStr.split(":");
  const modelId = rest.join(":");

  // Try exact match first, then prefix match against available models
  let model = getModel(provider as any, modelId as any);
  if (!model) {
    const available = getModels(provider as any);
    const found = available.find((m) => m.id.startsWith(modelId));
    if (found) model = found;
  }
  if (!model) {
    const available = getModels(provider as any);
    throw new Error(
      `Model not found: ${modelStr}\nAvailable ${provider} models: ${available.map((m) => m.id).join(", ")}`,
    );
  }

  const authStorage = new AuthStorage();
  const modelRegistry = new ModelRegistry(authStorage);

  // Use persistent sessions in cwd for resume support, or in-memory if not resuming
  const sessionManager = options.resume
    ? SessionManager.continueRecent(options.cwd)
    : SessionManager.create(options.cwd);

  const settingsManager = SettingsManager.inMemory({
    retry: { enabled: true, maxRetries: 3 },
  });

  const resourceLoader = new DefaultResourceLoader({
    cwd: options.cwd,
    settingsManager,
    systemPrompt: options.systemPrompt,
    extensionFactories: [preCompactExtension],
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd: options.cwd,
    model,
    authStorage,
    modelRegistry,
    sessionManager,
    settingsManager,
    resourceLoader,
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

  const toolArgs = new Map<string, any>();

  session.subscribe((event) => {
    if (event.type === "message_update") {
      const ae = event.assistantMessageEvent;
      if (ae.type === "text_delta") {
        logText(ae.delta);
        broadcast({ type: "text", content: ae.delta });
      } else if (ae.type === "thinking_delta") {
        logThinking(ae.delta);
      }
    }

    if (event.type === "tool_execution_start") {
      toolArgs.set(event.toolCallId, event.args);
      logToolUse(event.toolName, event.args);
      broadcast({
        type: "tool_use",
        name: event.toolName,
        input: event.args,
      });
    }

    if (event.type === "tool_execution_end") {
      const output = typeof event.result === "string" ? event.result : JSON.stringify(event.result);
      logToolResult(event.toolName, output, event.isError);
      broadcast({
        type: "tool_result",
        output,
        is_error: event.isError,
      });

      // Auto-commit file changes in home/
      if ((event.toolName === "Edit" || event.toolName === "Write") && !event.isError) {
        const args = toolArgs.get(event.toolCallId);
        const filePath = (args as { file_path?: string })?.file_path;
        if (filePath) {
          commitFileChange(filePath, options.cwd);
        }
      }
      toolArgs.delete(event.toolCallId);
    }

    if (event.type === "agent_end") {
      log("agent", "turn done");
      broadcast({ type: "done" });
    }
  });

  function sendMessage(content: string | VoluteContentPart[], meta?: ChannelMeta) {
    const raw =
      typeof content === "string"
        ? content
        : content
            .filter((p) => p.type === "text")
            .map((p) => (p as { text: string }).text)
            .join("\n");
    logMessage("in", raw, meta?.channel);

    // Build context prefix from channel metadata
    const prefix = formatPrefix(meta);
    const text = prefix + raw;

    // Convert image parts to pi-ai ImageContent format
    const images: ImageContent[] | undefined =
      typeof content === "string"
        ? undefined
        : content
            .filter((p) => p.type === "image")
            .map((p) => ({ type: "image" as const, mimeType: p.media_type, data: p.data }));

    const opts = images?.length ? { images } : {};

    if (session.isStreaming) {
      session.prompt(text, { streamingBehavior: "followUp", ...opts });
    } else {
      session.prompt(text, opts);
    }
  }

  function onMessage(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  return { sendMessage, onMessage };
}
