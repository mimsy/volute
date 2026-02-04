import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";
import { getModel } from "@mariozechner/pi-ai";
import type { MoltMessage, MoltBlock } from "./types.js";
import { log } from "./logger.js";

type Listener = (msg: MoltMessage) => void;

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
  const modelStr = options.model || process.env.PI_MODEL || "anthropic:claude-sonnet-4";
  const [provider, ...rest] = modelStr.split(":");
  const modelId = rest.join(":");
  const model = getModel(provider, modelId);
  if (!model) {
    throw new Error(`Model not found: ${modelStr}`);
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

  const { session } = await createAgentSession({
    cwd: options.cwd,
    model,
    thinkingLevel,
    systemPrompt: options.systemPrompt,
    authStorage,
    modelRegistry,
    sessionManager,
    settingsManager,
  });

  function broadcast(msg: MoltMessage) {
    for (const listener of listeners) {
      try {
        listener(msg);
      } catch (err) {
        log("agent", "listener threw during broadcast:", err);
      }
    }
  }

  // Track text/thinking blocks across streaming deltas to build complete messages
  let currentBlocks: MoltBlock[] = [];

  session.subscribe((event) => {
    if (event.type === "message_update") {
      const ae = event.assistantMessageEvent;
      if (ae.type === "text_delta") {
        currentBlocks.push({ type: "text", text: ae.delta });
        broadcast({
          role: "assistant",
          blocks: [{ type: "text", text: ae.delta }],
          timestamp: Date.now(),
        });
      } else if (ae.type === "thinking_delta") {
        currentBlocks.push({ type: "thinking", text: ae.delta });
        broadcast({
          role: "assistant",
          blocks: [{ type: "thinking", text: ae.delta }],
          timestamp: Date.now(),
        });
      }
    }

    if (event.type === "tool_execution_start") {
      const block: MoltBlock = {
        type: "tool_use",
        id: event.toolCallId,
        name: event.toolName,
        input: event.input,
      };
      currentBlocks.push(block);
      broadcast({
        role: "assistant",
        blocks: [block],
        timestamp: Date.now(),
      });
    }

    if (event.type === "tool_execution_end") {
      const block: MoltBlock = {
        type: "tool_result",
        tool_use_id: event.toolCallId,
        output: typeof event.result === "string" ? event.result : JSON.stringify(event.result),
        is_error: event.isError,
      };
      broadcast({
        role: "assistant",
        blocks: [block],
        timestamp: Date.now(),
      });
    }

    if (event.type === "agent_end") {
      log("agent", "turn done");
      currentBlocks = [];
      broadcast({
        role: "assistant",
        blocks: [],
        done: true,
        timestamp: Date.now(),
      });
    }

    if (event.type === "auto_compaction_end") {
      log("agent", "compaction completed");
      if (options.onCompact) options.onCompact();
    }
  });

  function sendMessage(text: string, _source?: string) {
    log("agent", "sendMessage:", text.slice(0, 120), _source ? `source=${_source}` : "");
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
