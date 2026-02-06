import { getModel, getModels } from "@mariozechner/pi-ai";
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
import type { VoluteContentPart, VoluteEvent } from "./types.js";

type Listener = (event: VoluteEvent) => void;

export async function createAgent(options: {
  systemPrompt: string;
  cwd: string;
  model?: string;
  thinkingLevel?: string;
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

  const thinkingLevel = (options.thinkingLevel || process.env.PI_THINKING_LEVEL || "medium") as
    | "off"
    | "minimal"
    | "low"
    | "medium"
    | "high"
    | "xhigh";

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
    thinkingLevel,
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
      logToolUse(event.toolName, event.input);
      broadcast({
        type: "tool_use",
        name: event.toolName,
        input: event.input,
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
        const filePath = (event.input as { file_path?: string })?.file_path;
        if (filePath) {
          commitFileChange(filePath, options.cwd);
        }
      }
    }

    if (event.type === "agent_end") {
      log("agent", "turn done");
      broadcast({ type: "done" });
    }
  });

  function sendMessage(content: string | VoluteContentPart[], source?: string, sender?: string) {
    // Convert to text for pi agent (images not yet supported by pi)
    const raw =
      typeof content === "string"
        ? content
        : content
            .filter((p) => p.type === "text")
            .map((p) => (p as { text: string }).text)
            .join("\n");
    logMessage("in", raw, source);

    // Build context prefix from channel/sender metadata
    const prefix = source && sender ? `[${source}: ${sender}]\n` : "";
    const text = prefix + raw;

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
