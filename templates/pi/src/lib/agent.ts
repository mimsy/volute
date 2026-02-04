import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";
import { getModel, getModels } from "@mariozechner/pi-ai";
import type { MoltEvent, MoltContentPart } from "./types.js";
import { log } from "./logger.js";

type Listener = (event: MoltEvent) => void;

export async function createAgent(options: {
  systemPrompt: string;
  cwd: string;
  model?: string;
  thinkingLevel?: string;
  resume?: boolean;
  onCompact?: () => void;
}) {
  const listeners = new Set<Listener>();

  // Parse model string: "provider:model-id" or use default
  const modelStr = options.model || process.env.PI_MODEL || "anthropic:claude-sonnet-4-20250514";
  const [provider, ...rest] = modelStr.split(":");
  const modelId = rest.join(":");

  // Try exact match first, then prefix match against available models
  let model = getModel(provider, modelId);
  if (!model) {
    const available = getModels(provider);
    model = available.find((m) => m.id.startsWith(modelId)) ?? null;
  }
  if (!model) {
    const available = getModels(provider);
    throw new Error(
      `Model not found: ${modelStr}\nAvailable ${provider} models: ${available.map((m) => m.id).join(", ")}`,
    );
  }

  const thinkingLevel = (options.thinkingLevel ||
    process.env.PI_THINKING_LEVEL ||
    "medium") as "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

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
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd: options.cwd,
    model,
    thinkingLevel,
    authStorage,
    modelRegistry,
    sessionManager,
    settingsManager,
    resourceLoader,
  });

  function broadcast(event: MoltEvent) {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch (err) {
        log("agent", "listener threw during broadcast:", err);
      }
    }
  }

  session.subscribe((event) => {
    if (event.type === "message_update") {
      const ae = event.assistantMessageEvent;
      if (ae.type === "text_delta") {
        broadcast({ type: "text", content: ae.delta });
      } else if (ae.type === "thinking_delta") {
        log("agent", "thinking:", ae.delta.slice(0, 200));
      }
    }

    if (event.type === "tool_execution_start") {
      broadcast({
        type: "tool_use",
        name: event.toolName,
        input: event.input,
      });
    }

    if (event.type === "tool_execution_end") {
      broadcast({
        type: "tool_result",
        output: typeof event.result === "string" ? event.result : JSON.stringify(event.result),
        is_error: event.isError,
      });
    }

    if (event.type === "agent_end") {
      log("agent", "turn done");
      broadcast({ type: "done" });
    }

    if (event.type === "auto_compaction_end") {
      log("agent", "compaction completed");
      if (options.onCompact) options.onCompact();
    }
  });

  function sendMessage(content: string | MoltContentPart[], _source?: string) {
    const preview = typeof content === "string"
      ? content.slice(0, 120)
      : content.map((p) => p.type).join(",");
    log("agent", "sendMessage:", preview, _source ? `source=${_source}` : "");

    // Convert to text for pi agent (images not yet supported by pi)
    const text = typeof content === "string"
      ? content
      : content.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join("\n");

    if (session.isStreaming) {
      session.prompt(text, { streamingBehavior: "followUp" });
    } else {
      session.prompt(text);
    }
  }

  function onMessage(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  return { sendMessage, onMessage };
}
