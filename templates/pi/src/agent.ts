import type { ImageContent } from "@mariozechner/pi-ai";
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
import { commitFileChange } from "./lib/auto-commit.js";
import { log, logText, logThinking, logToolResult, logToolUse } from "./lib/logger.js";
import type {
  ChannelMeta,
  HandlerResolver,
  Listener,
  MessageHandler,
  VoluteContentPart,
  VoluteEvent,
} from "./lib/types.js";

type AgentSession = Awaited<ReturnType<typeof createAgentSession>>["session"];

type PiSession = {
  name: string;
  agentSession: AgentSession | null;
  ready: Promise<void>;
  listeners: Set<Listener>;
  unsubscribe?: () => void;
  messageIds: (string | undefined)[];
  currentMessageId?: string;
};

const DEFAULT_COMPACTION_MESSAGE =
  "Your conversation is approaching its context limit. Please update today's journal entry to preserve important context before the conversation is compacted.";

function resolveModel(modelStr: string) {
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
  return model;
}

function extractText(content: VoluteContentPart[]): string {
  return content
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("\n");
}

function extractImages(content: VoluteContentPart[]): ImageContent[] {
  return content
    .filter((p): p is { type: "image"; media_type: string; data: string } => p.type === "image")
    .map((p) => ({ type: "image" as const, mimeType: p.media_type, data: p.data }));
}

export function createAgent(options: {
  systemPrompt: string;
  cwd: string;
  model?: string;
  compactionMessage?: string;
}): { resolve: HandlerResolver } {
  const sessions = new Map<string, PiSession>();
  const compactionMessage = options.compactionMessage ?? DEFAULT_COMPACTION_MESSAGE;

  // Shared setup (created once)
  const modelStr = options.model || process.env.PI_MODEL || "anthropic:claude-sonnet-4-20250514";
  const model = resolveModel(modelStr);
  const authStorage = new AuthStorage();
  const modelRegistry = new ModelRegistry(authStorage);

  // --- Session lifecycle ---

  function getOrCreateSession(name: string): PiSession {
    const existing = sessions.get(name);
    if (existing) return existing;

    const session: PiSession = {
      name,
      agentSession: null,
      ready: Promise.resolve(),
      listeners: new Set(),
      messageIds: [],
    };
    sessions.set(name, session);

    session.ready = initSession(session);
    return session;
  }

  async function initSession(session: PiSession) {
    const isEphemeral = session.name.startsWith("new-");

    const sessionManager = isEphemeral
      ? SessionManager.inMemory()
      : SessionManager.continueRecent(options.cwd, `.volute/pi-sessions/${session.name}`);

    log("agent", `session "${session.name}": ${isEphemeral ? "ephemeral" : "persistent"}`);

    let compactBlocked = false;
    const preCompactExtension: ExtensionFactory = (pi) => {
      pi.on("session_before_compact", () => {
        if (!compactBlocked) {
          compactBlocked = true;
          log(
            "agent",
            `session "${session.name}": blocking compaction — asking agent to update daily log`,
          );
          session.messageIds.push(undefined);
          session.agentSession?.prompt(compactionMessage, { streamingBehavior: "followUp" });
          return { cancel: true };
        }
        compactBlocked = false;
        log("agent", `session "${session.name}": allowing compaction`);
      });
    };

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

    const { session: agentSession } = await createAgentSession({
      cwd: options.cwd,
      model,
      authStorage,
      modelRegistry,
      sessionManager,
      settingsManager,
      resourceLoader,
    });

    session.agentSession = agentSession;

    // Per-session event subscription
    const toolArgs = new Map<string, any>();

    session.unsubscribe = agentSession.subscribe((event) => {
      if (session.currentMessageId === undefined) {
        session.currentMessageId = session.messageIds.shift();
      }

      if (event.type === "message_update") {
        const ae = event.assistantMessageEvent;
        if (ae.type === "text_delta") {
          logText(ae.delta);
          broadcast(session, { type: "text", content: ae.delta });
        } else if (ae.type === "thinking_delta") {
          logThinking(ae.delta);
        }
      }

      if (event.type === "tool_execution_start") {
        toolArgs.set(event.toolCallId, event.args);
        logToolUse(event.toolName, event.args);
        broadcast(session, { type: "tool_use", name: event.toolName, input: event.args });
      }

      if (event.type === "tool_execution_end") {
        const output =
          typeof event.result === "string" ? event.result : JSON.stringify(event.result);
        logToolResult(event.toolName, output, event.isError);
        broadcast(session, { type: "tool_result", output, is_error: event.isError });

        // Auto-commit file changes in home/
        if ((event.toolName === "edit" || event.toolName === "write") && !event.isError) {
          const args = toolArgs.get(event.toolCallId);
          const filePath = (args as { path?: string })?.path;
          if (filePath) {
            commitFileChange(filePath, options.cwd);
          }
        }
        toolArgs.delete(event.toolCallId);
      }

      if (event.type === "agent_end") {
        log("agent", `session "${session.name}": turn done`);
        broadcast(session, { type: "done" });
        session.currentMessageId = undefined;
      }
    });

    log("agent", `session "${session.name}": ready`);
  }

  // --- Event broadcasting ---

  function broadcast(session: PiSession, event: VoluteEvent) {
    const tagged =
      session.currentMessageId != null ? { ...event, messageId: session.currentMessageId } : event;
    for (const listener of session.listeners) {
      try {
        listener(tagged);
      } catch (err) {
        log("agent", "listener threw during broadcast:", err);
      }
    }
  }

  function interruptSession(name: string) {
    const session = sessions.get(name);
    if (session?.currentMessageId !== undefined) {
      log("agent", `session "${name}": interrupting current turn`);
      broadcast(session, { type: "done" });
      session.currentMessageId = undefined;
    }
  }

  // --- MessageHandler implementation ---

  function createSessionHandler(sessionName: string): MessageHandler {
    return {
      handle(
        content: VoluteContentPart[],
        meta: ChannelMeta & { messageId: string },
        listener: Listener,
      ): () => void {
        const session = getOrCreateSession(sessionName);

        // Filter listener to only receive events for this messageId
        const filteredListener: Listener = (event) => {
          if (event.messageId === meta.messageId) listener(event);
        };
        session.listeners.add(filteredListener);

        // Track messageId (must be pushed before prompt)
        session.messageIds.push(meta.messageId);

        const text = extractText(content);
        const images = extractImages(content);
        const opts = images.length ? { images } : {};

        // Fire-and-forget: await session ready then prompt
        (async () => {
          await session.ready;
          if (session.agentSession!.isStreaming) {
            if (meta.interrupt) {
              interruptSession(sessionName);
              session.agentSession!.prompt(text, { streamingBehavior: "steer", ...opts });
            } else {
              session.agentSession!.prompt(text, { streamingBehavior: "followUp", ...opts });
            }
          } else {
            session.agentSession!.prompt(text, opts);
          }
        })();

        return () => session.listeners.delete(filteredListener);
      },
    };
  }

  // --- HandlerResolver ---

  const handlers = new Map<string, MessageHandler>();

  function resolve(sessionName: string): MessageHandler {
    let handler = handlers.get(sessionName);
    if (!handler) {
      handler = createSessionHandler(sessionName);
      handlers.set(sessionName, handler);
    }
    return handler;
  }

  return { resolve };
}
