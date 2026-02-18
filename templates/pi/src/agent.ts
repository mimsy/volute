import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionFactory,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";
import {
  type AutoReplyTracker,
  createAutoReplyTracker,
  type MessageChannelInfo,
} from "./lib/auto-reply.js";
import { extractImages, extractText } from "./lib/content.js";
import { createEventHandler } from "./lib/event-handler.js";
import { log } from "./lib/logger.js";
import { resolveModel } from "./lib/resolve-model.js";
import { createSessionContextExtension } from "./lib/session-context-extension.js";
import type {
  HandlerMeta,
  HandlerResolver,
  Listener,
  MessageHandler,
  VoluteContentPart,
  VoluteEvent,
} from "./lib/types.js";

type PiAgentSession = Awaited<ReturnType<typeof createAgentSession>>["session"];

type PiSession = {
  name: string;
  agentSession: PiAgentSession | null;
  ready: Promise<void>;
  listeners: Set<Listener>;
  unsubscribe?: () => void;
  messageIds: (string | undefined)[];
  currentMessageId?: string;
  messageChannels: Map<string, MessageChannelInfo>;
  autoReply: AutoReplyTracker;
};

function defaultCompactionMessage(): string {
  const today = new Date().toISOString().slice(0, 10);
  return `Context is getting long — compaction is about to summarize this conversation. Before that happens, save anything important to files (MEMORY.md, memory/journal/${today}.md, etc.) since those survive compaction. Focus on: decisions made, open tasks, and anything you'd need to pick up where you left off.`;
}

export function createMind(options: {
  systemPrompt: string;
  cwd: string;
  model?: string;
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  compactionMessage?: string;
}): { resolve: HandlerResolver } {
  const sessions = new Map<string, PiSession>();
  const compactionMessage = options.compactionMessage ?? defaultCompactionMessage();

  // Shared setup (created once)
  const modelStr = options.model || process.env.PI_MODEL || "anthropic:claude-sonnet-4-20250514";
  const model = resolveModel(modelStr);
  const authStorage = new AuthStorage();
  const modelRegistry = new ModelRegistry(authStorage);

  // --- Session lifecycle ---

  function getOrCreateSession(name: string): PiSession {
    const existing = sessions.get(name);
    if (existing) return existing;

    const messageChannels = new Map<string, MessageChannelInfo>();
    const session: PiSession = {
      name,
      agentSession: null,
      ready: Promise.resolve(),
      listeners: new Set(),
      messageIds: [],
      messageChannels,
      autoReply: createAutoReplyTracker(messageChannels),
    };
    sessions.set(name, session);

    session.ready = initSession(session).catch((err) => {
      session.autoReply.reset();
      session.messageChannels.clear();
      log("mind", `session "${session.name}": init failed:`, err);
    });
    return session;
  }

  async function initSession(session: PiSession) {
    const isEphemeral = session.name.startsWith("new-");

    const sessionManager = isEphemeral
      ? SessionManager.inMemory()
      : SessionManager.continueRecent(options.cwd, `.volute/pi-sessions/${session.name}`);

    log("mind", `session "${session.name}": ${isEphemeral ? "ephemeral" : "persistent"}`);

    let compactBlocked = false;
    const preCompactExtension: ExtensionFactory = (pi) => {
      pi.on("session_before_compact", () => {
        if (!compactBlocked) {
          compactBlocked = true;
          log(
            "mind",
            `session "${session.name}": blocking compaction — asking mind to update daily log`,
          );
          session.messageIds.push(undefined);
          session.agentSession?.prompt(compactionMessage, { streamingBehavior: "followUp" });
          return { cancel: true };
        }
        compactBlocked = false;
        log("mind", `session "${session.name}": allowing compaction`);
      });
    };

    const settingsManager = SettingsManager.inMemory({
      retry: { enabled: true, maxRetries: 3 },
    });

    const sessionContextExtension = createSessionContextExtension({
      currentSession: session.name,
      cwd: options.cwd,
    });

    const resourceLoader = new DefaultResourceLoader({
      cwd: options.cwd,
      settingsManager,
      systemPrompt: options.systemPrompt,
      extensionFactories: [preCompactExtension, sessionContextExtension],
    });
    await resourceLoader.reload();

    const { session: agentSession } = await createAgentSession({
      cwd: options.cwd,
      model,
      thinkingLevel: options.thinkingLevel,
      authStorage,
      modelRegistry,
      sessionManager,
      settingsManager,
      resourceLoader,
    });

    session.agentSession = agentSession;

    session.unsubscribe = agentSession.subscribe(
      createEventHandler(session, {
        cwd: options.cwd,
        broadcast: (event) => broadcast(session, event),
      }),
    );

    log("mind", `session "${session.name}": ready`);
  }

  // --- Event broadcasting ---

  function broadcast(session: PiSession, event: VoluteEvent) {
    const tagged =
      session.currentMessageId != null ? { ...event, messageId: session.currentMessageId } : event;
    for (const listener of session.listeners) {
      try {
        listener(tagged);
      } catch (err) {
        log("mind", "listener threw during broadcast:", err);
      }
    }
  }

  function interruptSession(name: string) {
    const session = sessions.get(name);
    if (session?.currentMessageId !== undefined) {
      log("mind", `session "${name}": interrupting current turn`);
      broadcast(session, { type: "done" });
      session.currentMessageId = undefined;
    }
  }

  // --- MessageHandler implementation ---

  function createSessionHandler(sessionName: string): MessageHandler {
    return {
      handle(content: VoluteContentPart[], meta: HandlerMeta, listener: Listener): () => void {
        const session = getOrCreateSession(sessionName);

        // Filter listener to only receive events for this messageId
        const filteredListener: Listener = (event) => {
          if (event.messageId === meta.messageId) listener(event);
        };
        session.listeners.add(filteredListener);

        // Track channel for auto-reply
        if (meta.channel) {
          session.messageChannels.set(meta.messageId, {
            channel: meta.channel,
            autoReply: meta.autoReply,
          });
        }

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
        })().catch((err) => {
          log("mind", `session "${sessionName}": prompt failed:`, err);
          broadcast(session, { type: "done" });
        });

        return () => session.listeners.delete(filteredListener);
      },
    };
  }

  // --- HandlerResolver ---

  const handlers = new Map<string, MessageHandler>();

  function resolve(sessionName: string): MessageHandler {
    // Ephemeral sessions get unique names — don't cache their handlers
    if (sessionName.startsWith("new-")) {
      return createSessionHandler(sessionName);
    }
    let handler = handlers.get(sessionName);
    if (!handler) {
      handler = createSessionHandler(sessionName);
      handlers.set(sessionName, handler);
    }
    return handler;
  }

  return { resolve };
}
