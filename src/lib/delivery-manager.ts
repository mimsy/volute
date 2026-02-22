import { and, eq, sql } from "drizzle-orm";
import { getDb } from "./db.js";
import {
  getRoutingConfig,
  type MatchMeta,
  type ResolvedDeliveryMode,
  type ResolvedSessionConfig,
  resolveDeliveryMode,
  resolveRoute,
} from "./delivery-router.js";
import log from "./logger.js";
import { type DeliveryPayload, extractTextContent } from "./message-delivery.js";
import { findMind } from "./registry.js";
import { deliveryQueue } from "./schema.js";
import { getTypingMap } from "./typing.js";
import { findVariant } from "./variants.js";

const dlog = log.child("delivery-manager");

const MAX_BATCH_SIZE = 50;

// --- Session state tracking ---

type SessionState = {
  activeCount: number;
  lastDeliveredAt: number;
};

// --- Batch buffer ---

type BatchBuffer = {
  messages: QueuedMessage[];
  debounceTimer: ReturnType<typeof setTimeout> | null;
  maxWaitTimer: ReturnType<typeof setTimeout> | null;
  delivery: Extract<ResolvedDeliveryMode, { mode: "batch" }>;
};

type QueuedMessage = {
  payload: DeliveryPayload;
  channel: string;
  sender: string | null;
  createdAt: number;
};

// --- Delivery Manager ---

export class DeliveryManager {
  private sessionStates = new Map<string, Map<string, SessionState>>();
  private batchBuffers = new Map<string, BatchBuffer>();

  // --- Public API ---

  /**
   * Route and deliver a message to a mind. This is the main entry point.
   * The message is routed via the mind's routes.json, then either delivered immediately
   * or queued for batching depending on the session's delivery mode.
   */
  async routeAndDeliver(
    mindName: string,
    payload: DeliveryPayload,
  ): Promise<
    | {
        routed: true;
        session: string;
        destination: "mind" | "file";
        mode: "immediate" | "batch" | "gated";
      }
    | {
        routed: false;
        reason: string;
      }
  > {
    const [baseName] = mindName.split("@", 2);
    const config = getRoutingConfig(baseName);

    const meta: MatchMeta = {
      channel: payload.channel,
      sender: payload.sender ?? undefined,
      isDM: payload.isDM,
      participantCount: payload.participantCount,
    };

    const route = resolveRoute(config, meta);

    // File destination — not handled by delivery manager
    if (route.destination === "file") {
      return { routed: true, session: route.path, destination: "file", mode: "immediate" };
    }

    // Gating: unmatched channels with gateUnmatched enabled
    if (!route.matched && config.gateUnmatched !== false) {
      await this.gateMessage(mindName, route.session, payload);
      return { routed: true, session: route.session, destination: "mind", mode: "gated" };
    }

    // Mention-mode filtering
    if (route.mode === "mention" && payload.sender) {
      const text = extractTextContent(payload.content);
      const escaped = baseName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = new RegExp(`\\b${escaped}\\b`, "i");
      if (!pattern.test(text)) {
        return { routed: false, reason: "mention-filtered" };
      }
    }

    // Resolve session name ($new expansion)
    let sessionName = route.session;
    if (sessionName === "$new") {
      sessionName = `new-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    }

    // Resolve delivery mode for this session
    const sessionConfig = resolveDeliveryMode(config, sessionName);

    if (sessionConfig.delivery.mode === "batch") {
      this.enqueueBatch(mindName, sessionName, payload, sessionConfig);
      return { routed: true, session: sessionName, destination: "mind", mode: "batch" };
    }

    // Immediate delivery
    await this.deliverToMind(mindName, sessionName, payload, sessionConfig);
    return { routed: true, session: sessionName, destination: "mind", mode: "immediate" };
  }

  /**
   * Called when a mind's session emits a "done" event — decrements active count
   * and may trigger batch flush if session goes idle.
   */
  sessionDone(mindName: string, session?: string): void {
    const [baseName] = mindName.split("@", 2);

    if (session) {
      this.decrementActive(baseName, session);
    } else {
      // No session specified — decrement all sessions for this mind
      const mindSessions = this.sessionStates.get(baseName);
      if (mindSessions) {
        for (const [sessionName] of mindSessions) {
          this.decrementActive(baseName, sessionName);
        }
      }
    }
  }

  /**
   * Restore queued messages from DB on daemon restart.
   */
  async restoreFromDb(): Promise<void> {
    try {
      const db = await getDb();
      const rows = await db.select().from(deliveryQueue).where(eq(deliveryQueue.status, "pending"));

      for (const row of rows) {
        let payload: DeliveryPayload;
        try {
          payload = JSON.parse(row.payload) as DeliveryPayload;
        } catch (parseErr) {
          dlog.warn(
            `corrupt payload in delivery queue row ${row.id}, skipping`,
            log.errorData(parseErr),
          );
          continue;
        }
        const config = getRoutingConfig(row.mind);
        const sessionConfig = resolveDeliveryMode(config, row.session);

        if (sessionConfig.delivery.mode === "batch") {
          this.addToBatchBuffer(row.mind, row.session, payload, sessionConfig);
        } else {
          // Immediate messages that were queued but not delivered — deliver now
          this.deliverToMind(row.mind, row.session, payload, sessionConfig)
            .then(async () => {
              // Clean up the delivered row
              try {
                const db2 = await getDb();
                await db2.delete(deliveryQueue).where(eq(deliveryQueue.id, row.id));
              } catch {}
            })
            .catch((err) => {
              dlog.warn(`failed to restore delivery for ${row.mind}`, log.errorData(err));
            });
        }
      }

      if (rows.length > 0) {
        dlog.info(`restored ${rows.length} queued messages from DB`);
      }
    } catch (err) {
      dlog.warn("failed to restore delivery queue from DB", log.errorData(err));
    }
  }

  /**
   * Get pending (gated) messages for a mind.
   */
  async getPending(mindName: string): Promise<
    {
      channel: string | null;
      sender: string | null;
      count: number;
      firstSeen: string;
      preview: string;
    }[]
  > {
    const db = await getDb();
    const rows = await db
      .select()
      .from(deliveryQueue)
      .where(and(eq(deliveryQueue.mind, mindName), eq(deliveryQueue.status, "gated")));

    // Group by channel
    const byChannel = new Map<string, typeof rows>();
    for (const row of rows) {
      const ch = row.channel ?? "unknown";
      const existing = byChannel.get(ch) ?? [];
      existing.push(row);
      byChannel.set(ch, existing);
    }

    return [...byChannel.entries()].map(([channel, channelRows]) => {
      const firstRow = channelRows[0];
      const payload = JSON.parse(firstRow.payload) as DeliveryPayload;
      const text = extractTextContent(payload.content);
      return {
        channel,
        sender: firstRow.sender,
        count: channelRows.length,
        firstSeen: firstRow.created_at,
        preview: text.length > 200 ? `${text.slice(0, 200)}...` : text,
      };
    });
  }

  /**
   * Check if a session is currently busy (has active deliveries).
   */
  isSessionBusy(mindName: string, session: string): boolean {
    const state = this.sessionStates.get(mindName)?.get(session);
    return (state?.activeCount ?? 0) > 0;
  }

  /**
   * Cleanup all timers and subscriptions.
   */
  dispose(): void {
    for (const [, buffer] of this.batchBuffers) {
      if (buffer.debounceTimer) clearTimeout(buffer.debounceTimer);
      if (buffer.maxWaitTimer) clearTimeout(buffer.maxWaitTimer);
    }
    this.batchBuffers.clear();
    this.sessionStates.clear();
    if (instance === this) instance = undefined;
  }

  // --- Private ---

  private async deliverToMind(
    mindName: string,
    session: string,
    payload: DeliveryPayload,
    sessionConfig: ResolvedSessionConfig,
  ): Promise<void> {
    const [baseName, variantName] = mindName.split("@", 2);
    const entry = findMind(baseName);
    if (!entry) {
      dlog.warn(`cannot deliver to ${mindName}: mind not found`);
      return;
    }

    let port = entry.port;
    if (variantName) {
      const variant = findVariant(baseName, variantName);
      if (!variant) {
        dlog.warn(`cannot deliver to ${mindName}: variant not found`);
        return;
      }
      port = variant.port;
    }

    // Increment active count before delivery
    this.incrementActive(baseName, session);

    // Set typing indicator
    const typingMap = getTypingMap();
    if (payload.channel) {
      typingMap.set(payload.channel, baseName, { persistent: true });
    }

    // Build the delivery body with session pre-set
    const deliveryBody = {
      ...payload,
      session,
      interrupt: sessionConfig.interrupt,
      instructions: sessionConfig.instructions,
    };

    const body = JSON.stringify(deliveryBody);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);

    try {
      const res = await fetch(`http://127.0.0.1:${port}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        dlog.warn(`mind ${mindName} responded ${res.status}: ${text}`);
        // On error, decrement active and clear typing
        this.decrementActive(baseName, session);
        if (payload.channel) typingMap.delete(payload.channel, baseName);
      } else {
        await res.text().catch(() => {});
      }
    } catch (err) {
      dlog.warn(`failed to deliver to ${mindName}`, log.errorData(err));
      this.decrementActive(baseName, session);
      if (payload.channel) typingMap.delete(payload.channel, baseName);
    } finally {
      clearTimeout(timeout);
    }
  }

  private async deliverBatchToMind(
    mindName: string,
    session: string,
    messages: QueuedMessage[],
    sessionConfig: ResolvedSessionConfig,
  ): Promise<void> {
    const [baseName, variantName] = mindName.split("@", 2);
    const entry = findMind(baseName);
    if (!entry) {
      dlog.warn(`cannot deliver batch to ${mindName}: mind not found`);
      return;
    }

    let port = entry.port;
    if (variantName) {
      const variant = findVariant(baseName, variantName);
      if (!variant) {
        dlog.warn(`cannot deliver batch to ${mindName}: variant not found`);
        return;
      }
      port = variant.port;
    }

    // Group messages by channel
    const channels: Record<string, DeliveryPayload[]> = {};
    for (const msg of messages) {
      const ch = msg.channel ?? "unknown";
      if (!channels[ch]) channels[ch] = [];
      channels[ch].push(msg.payload);
    }

    // Increment active count
    this.incrementActive(baseName, session);

    // Set typing indicators for all real channels in the batch
    const typingMap = getTypingMap();
    for (const ch of Object.keys(channels)) {
      if (ch !== "unknown") typingMap.set(ch, baseName, { persistent: true });
    }

    const batchBody = {
      session,
      batch: { channels },
      interrupt: sessionConfig.interrupt,
      instructions: sessionConfig.instructions,
    };

    const body = JSON.stringify(batchBody);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);

    try {
      const res = await fetch(`http://127.0.0.1:${port}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        dlog.warn(`mind ${mindName} batch responded ${res.status}: ${text}`);
        this.decrementActive(baseName, session);
        for (const ch of Object.keys(channels)) {
          typingMap.delete(ch, baseName);
        }
      } else {
        await res.text().catch(() => {});
        // Clean up DB entries only after successful delivery
        try {
          const db = await getDb();
          await db
            .delete(deliveryQueue)
            .where(
              and(
                eq(deliveryQueue.mind, baseName),
                eq(deliveryQueue.session, session),
                eq(deliveryQueue.status, "pending"),
              ),
            );
        } catch (err) {
          dlog.warn(
            `failed to clean delivery queue for ${baseName}/${session}`,
            log.errorData(err),
          );
        }
      }
    } catch (err) {
      dlog.warn(`failed to deliver batch to ${mindName}`, log.errorData(err));
      this.decrementActive(baseName, session);
      for (const ch of Object.keys(channels)) {
        typingMap.delete(ch, baseName);
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  private enqueueBatch(
    mindName: string,
    session: string,
    payload: DeliveryPayload,
    sessionConfig: ResolvedSessionConfig,
  ): void {
    const delivery = sessionConfig.delivery as Extract<ResolvedDeliveryMode, { mode: "batch" }>;

    // Check triggers — immediate flush if matched
    if (delivery.triggers?.length) {
      const text = extractTextContent(payload.content);
      const lower = text.toLowerCase();
      if (delivery.triggers.some((t) => lower.includes(t.toLowerCase()))) {
        // Flush existing buffer + this message immediately
        this.flushBatch(mindName, session, [
          {
            payload,
            channel: payload.channel,
            sender: payload.sender ?? null,
            createdAt: Date.now(),
          },
        ]);
        return;
      }
    }

    // Persist to DB
    this.persistToQueue(mindName, session, payload).catch((err) => {
      dlog.warn(`failed to persist batch message for ${mindName}/${session}`, log.errorData(err));
    });

    this.addToBatchBuffer(mindName, session, payload, sessionConfig);
  }

  private addToBatchBuffer(
    mindName: string,
    session: string,
    payload: DeliveryPayload,
    sessionConfig: ResolvedSessionConfig,
  ): void {
    const delivery = sessionConfig.delivery as Extract<ResolvedDeliveryMode, { mode: "batch" }>;
    const bufferKey = `${mindName}:${session}`;

    let buffer = this.batchBuffers.get(bufferKey);
    if (!buffer) {
      buffer = {
        messages: [],
        debounceTimer: null,
        maxWaitTimer: null,
        delivery,
      };
      this.batchBuffers.set(bufferKey, buffer);
    }

    buffer.messages.push({
      payload,
      channel: payload.channel,
      sender: payload.sender ?? null,
      createdAt: Date.now(),
    });

    // Max batch size — force flush
    if (buffer.messages.length >= MAX_BATCH_SIZE) {
      this.flushBatch(mindName, session);
      return;
    }

    this.scheduleBatchTimers(mindName, session, bufferKey);
  }

  private scheduleBatchTimers(mindName: string, session: string, bufferKey: string): void {
    const buffer = this.batchBuffers.get(bufferKey);
    if (!buffer) return;

    // Reset debounce timer
    if (buffer.debounceTimer) clearTimeout(buffer.debounceTimer);
    buffer.debounceTimer = setTimeout(() => {
      // Only flush if session is idle
      if (!this.isSessionBusy(mindName, session)) {
        this.flushBatch(mindName, session);
      }
      // If busy, will flush when session goes idle
    }, buffer.delivery.debounce * 1000);
    buffer.debounceTimer.unref();

    // Start maxWait timer if not already running
    if (!buffer.maxWaitTimer) {
      buffer.maxWaitTimer = setTimeout(() => {
        this.flushBatch(mindName, session);
      }, buffer.delivery.maxWait * 1000);
      buffer.maxWaitTimer.unref();
    }
  }

  private flushBatch(mindName: string, session: string, extra?: QueuedMessage[]): void {
    const bufferKey = `${mindName}:${session}`;
    const buffer = this.batchBuffers.get(bufferKey);

    const messages: QueuedMessage[] = [];
    if (buffer) {
      if (buffer.debounceTimer) clearTimeout(buffer.debounceTimer);
      if (buffer.maxWaitTimer) clearTimeout(buffer.maxWaitTimer);
      buffer.debounceTimer = null;
      buffer.maxWaitTimer = null;
      messages.push(...buffer.messages.splice(0));
      this.batchBuffers.delete(bufferKey);
    }
    if (extra) messages.push(...extra);

    if (messages.length === 0) return;

    const [baseName] = mindName.split("@", 2);
    const config = getRoutingConfig(baseName);
    const sessionConfig = resolveDeliveryMode(config, session);

    dlog.info(`flushing batch for ${mindName}/${session}: ${messages.length} messages`);
    this.deliverBatchToMind(mindName, session, messages, sessionConfig).catch((err) => {
      dlog.warn(`failed to flush batch for ${mindName}/${session}`, log.errorData(err));
    });
  }

  private async gateMessage(
    mindName: string,
    session: string,
    payload: DeliveryPayload,
  ): Promise<void> {
    const [baseName] = mindName.split("@", 2);
    await this.persistToQueue(baseName, session, payload, "gated");

    // Check if this is the first gated message for this channel — send invite
    try {
      const db = await getDb();
      const count = await db
        .select({ count: sql<number>`count(*)` })
        .from(deliveryQueue)
        .where(
          and(
            eq(deliveryQueue.mind, baseName),
            eq(deliveryQueue.channel, payload.channel),
            eq(deliveryQueue.status, "gated"),
          ),
        );

      // If this is the first (count === 1 after our insert), send invite
      if ((count[0]?.count ?? 0) <= 1) {
        await this.sendInviteNotification(mindName, payload);
      }
    } catch (err) {
      dlog.warn(`failed to check gated count for ${baseName}`, log.errorData(err));
    }
  }

  private async sendInviteNotification(mindName: string, payload: DeliveryPayload): Promise<void> {
    const text = extractTextContent(payload.content);
    const preview = text.length > 200 ? `${text.slice(0, 200)}...` : text;
    const channel = payload.channel ?? "unknown";

    const notification = [
      `[New channel: ${channel}]`,
      `Sender: ${payload.sender ?? "unknown"}`,
      payload.platform ? `Platform: ${payload.platform}` : null,
      payload.participantCount ? `Participants: ${payload.participantCount}` : null,
      "",
      `Preview: ${preview}`,
      "",
      `To accept this channel, add a routing rule for "${channel}" to your routes.json.`,
      `Messages are being held until a route is configured.`,
    ]
      .filter((line) => line !== null)
      .join("\n");

    const invitePayload: DeliveryPayload = {
      channel: "system:delivery",
      sender: "system",
      content: notification,
    };

    const config = getRoutingConfig(mindName.split("@", 2)[0]);
    const sessionConfig = resolveDeliveryMode(config, "main");

    await this.deliverToMind(mindName, "main", invitePayload, {
      ...sessionConfig,
      interrupt: true,
    });
  }

  private async persistToQueue(
    mindName: string,
    session: string,
    payload: DeliveryPayload,
    status: "pending" | "gated" = "pending",
  ): Promise<void> {
    try {
      const db = await getDb();
      await db.insert(deliveryQueue).values({
        mind: mindName,
        session,
        channel: payload.channel ?? null,
        sender: payload.sender ?? null,
        status,
        payload: JSON.stringify(payload),
      });
    } catch (err) {
      dlog.warn(
        `failed to persist to delivery queue for ${mindName}/${session}`,
        log.errorData(err),
      );
    }
  }

  private incrementActive(mind: string, session: string): void {
    let mindSessions = this.sessionStates.get(mind);
    if (!mindSessions) {
      mindSessions = new Map();
      this.sessionStates.set(mind, mindSessions);
    }
    const state = mindSessions.get(session) ?? { activeCount: 0, lastDeliveredAt: 0 };
    state.activeCount++;
    state.lastDeliveredAt = Date.now();
    mindSessions.set(session, state);
  }

  private decrementActive(mind: string, session: string): void {
    const mindSessions = this.sessionStates.get(mind);
    if (!mindSessions) return;
    const state = mindSessions.get(session);
    if (!state) return;

    state.activeCount = Math.max(0, state.activeCount - 1);

    // If session went idle, check for pending batch
    if (state.activeCount === 0) {
      const bufferKey = `${mind}:${session}`;
      const buffer = this.batchBuffers.get(bufferKey);
      if (buffer && buffer.messages.length > 0) {
        // Session idle + messages buffered → flush after debounce
        this.scheduleBatchTimers(mind, session, bufferKey);
      }
    }
  }
}

// --- Singleton ---

let instance: DeliveryManager | undefined;

export function initDeliveryManager(): DeliveryManager {
  if (instance) return instance;
  instance = new DeliveryManager();
  return instance;
}

export function getDeliveryManager(): DeliveryManager {
  if (!instance) {
    throw new Error("DeliveryManager not initialized — call initDeliveryManager() first");
  }
  return instance;
}
