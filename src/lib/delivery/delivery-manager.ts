import { readFile, realpath } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../db.js";
import { getParticipants } from "../events/conversations.js";
import log from "../logger.js";
import { findMind, getBaseName, mindDir, voluteHome } from "../registry.js";
import { deliveryQueue } from "../schema.js";
import { getTypingMap, publishTypingForChannels } from "../typing.js";
import { readVoluteConfig } from "../volute-config.js";
import {
  type DeliveryPayload,
  extractTextContent,
  getRoutingConfig,
  type MatchMeta,
  type ParticipantProfile,
  type ResolvedDeliveryMode,
  type ResolvedSessionConfig,
  resolveDeliveryMode,
  resolveRoute,
} from "./delivery-router.js";
import { tagRecentInbound } from "./message-delivery.js";

const dlog = log.child("delivery-manager");

const MAX_BATCH_SIZE = 50;

// --- Session state tracking ---

type SessionState = {
  activeCount: number;
  lastDeliveredAt: number;
  lastDeliverySenders: Set<string>;
  lastDeliveryChannels: Set<string>;
  lastInterruptAt: number;
  seenChannelProfiles: Set<string>;
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
    const baseName = await getBaseName(mindName);
    const config = getRoutingConfig(baseName);

    // Explicit session in payload — skip route matching entirely
    if (payload.session) {
      let sessionName = payload.session;
      if (sessionName === "$new") {
        sessionName = `new-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      }
      const sessionConfig = resolveDeliveryMode(config, sessionName);
      if (sessionConfig.delivery.mode === "batch") {
        await this.enqueueBatch(mindName, sessionName, payload, sessionConfig);
        return { routed: true, session: sessionName, destination: "mind", mode: "batch" };
      }
      await this.deliverToMind(mindName, sessionName, payload, sessionConfig);
      return { routed: true, session: sessionName, destination: "mind", mode: "immediate" };
    }

    const meta: MatchMeta = {
      channel: payload.channel,
      sender: payload.sender ?? undefined,
      isDM: payload.isDM,
      participantCount: payload.participantCount,
    };

    const route = resolveRoute(config, meta);

    dlog.debug(
      `route for ${mindName} ch=${payload.channel}: dest=${route.destination} matched=${route.matched}`,
    );

    // File destination — not handled by delivery manager
    if (route.destination === "file") {
      return { routed: true, session: route.path, destination: "file", mode: "immediate" };
    }

    // Gating: unmatched channels with gateUnmatched enabled
    if (!route.matched && config.gateUnmatched !== false) {
      dlog.debug(`gating unmatched channel ${payload.channel} for ${mindName}`);
      await this.gateMessage(mindName, route.session, payload);
      return { routed: true, session: route.session, destination: "mind", mode: "gated" };
    }

    // Mention-mode filtering
    if (route.mode === "mention" && payload.sender) {
      const text = extractTextContent(payload.content);
      const escaped = baseName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = new RegExp(`\\b${escaped}\\b`, "i");
      if (!pattern.test(text)) {
        dlog.debug(`mention-filtered message on ${payload.channel} for ${mindName}`);
        return { routed: false, reason: "mention-filtered" };
      }
    }

    // Resolve session name ($new expansion)
    let sessionName = route.session;
    if (sessionName === "$new") {
      sessionName = `new-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    }

    // Tag the most recent untagged inbound with the active turn for this session.
    // This links incoming messages to the current turn immediately so live streams
    // can group them correctly, and handles interrupts (message arriving mid-turn).
    tagRecentInbound(baseName, sessionName, payload.channel).catch((err) => {
      dlog.warn(`tagRecentInbound failed for ${baseName}`, log.errorData(err));
    });

    // Resolve delivery mode for this session (pass matched rule for rule-level batch config)
    const sessionConfig = resolveDeliveryMode(config, sessionName, route.rule);

    if (sessionConfig.delivery.mode === "batch") {
      dlog.debug(`enqueueing batch message for ${mindName}/${sessionName}`);
      await this.enqueueBatch(mindName, sessionName, payload, sessionConfig);
      return { routed: true, session: sessionName, destination: "mind", mode: "batch" };
    }

    // Immediate delivery
    await this.deliverToMind(mindName, sessionName, payload, sessionConfig);
    return { routed: true, session: sessionName, destination: "mind", mode: "immediate" };
  }

  /**
   * Called when a mind's session emits a "done" event — decrements active count
   * and may trigger batch flush if session goes idle.
   *
   * This method is intentionally synchronous to avoid race conditions: the caller
   * has already resolved baseName, and any async yield here (e.g. getBaseName)
   * would allow concurrent deliveries to incrementActive before the decrement runs,
   * causing isSessionBusy to return true even when no deliveries are pending.
   */
  sessionDone(baseName: string, session?: string): void {
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
          // Immediate messages that were queued but not delivered — delete first
          // to prevent re-delivery on daemon crash during replay
          try {
            await db.delete(deliveryQueue).where(eq(deliveryQueue.id, row.id));
          } catch (err) {
            dlog.warn(`failed to delete queue row ${row.id} for ${row.mind}`, log.errorData(err));
          }
          this.deliverToMind(row.mind, row.session, payload, sessionConfig).catch((err) => {
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
   * Check if any session for a mind is currently busy.
   */
  isMindBusy(mindName: string): boolean {
    const mindSessions = this.sessionStates.get(mindName);
    if (!mindSessions) return false;
    for (const [, state] of mindSessions) {
      if (state.activeCount > 0) return true;
    }
    return false;
  }

  /**
   * Clear all session state for a specific mind (called on mind stop/crash).
   * Resets active counts and cleans up batch buffers so ghost counts don't accumulate.
   */
  clearMindSessions(mindName: string): void {
    this.sessionStates.delete(mindName);
    // Clean up any batch buffers for this mind
    const toDelete: string[] = [];
    for (const [bufferKey, buffer] of this.batchBuffers) {
      if (bufferKey.startsWith(`${mindName}:`)) {
        if (buffer.debounceTimer) clearTimeout(buffer.debounceTimer);
        if (buffer.maxWaitTimer) clearTimeout(buffer.maxWaitTimer);
        toDelete.push(bufferKey);
      }
    }
    for (const k of toDelete) this.batchBuffers.delete(k);
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

  private async resolvePort(mindName: string): Promise<{ baseName: string; port: number } | null> {
    const entry = await findMind(mindName);
    if (!entry) return null;
    const baseName = entry.parent ?? mindName;
    return { baseName, port: entry.port };
  }

  private async postToMind(port: number, body: string): Promise<boolean> {
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
        dlog.warn(`mind responded ${res.status}: ${text}`);
        return false;
      }
      await res.text().catch(() => {});
      return true;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async deliverToMind(
    mindName: string,
    session: string,
    payload: DeliveryPayload,
    sessionConfig: ResolvedSessionConfig,
  ): Promise<void> {
    const resolved = await this.resolvePort(mindName);
    if (!resolved) {
      dlog.warn(`cannot deliver to ${mindName}: mind not found`);
      return;
    }
    const { baseName, port } = resolved;

    // Increment active count before delivery with sender/channel metadata
    const senders = new Set<string>();
    if (payload.sender) senders.add(payload.sender);
    const channels = new Set<string>();
    if (payload.channel) channels.add(payload.channel);
    this.incrementActive(baseName, session, senders, channels);

    // Set typing indicator on both slug and conversationId keys
    const typingMap = getTypingMap();
    if (payload.channel) {
      typingMap.set(payload.channel, baseName, { persistent: true });
    }
    if (payload.conversationId) {
      typingMap.set(payload.conversationId, baseName, { persistent: true });
    }

    // Enrich with participant profiles on first encounter per channel
    const enrichedPayload = await this.enrichWithProfiles(baseName, session, payload);

    const body = JSON.stringify({
      ...enrichedPayload,
      session,
      interrupt: sessionConfig.interrupt,
      instructions: sessionConfig.instructions,
    });

    try {
      const ok = await this.postToMind(port, body);
      if (!ok) {
        this.decrementActive(baseName, session);
        publishTypingForChannels(typingMap.deleteSender(baseName), typingMap);
      }
    } catch (err) {
      dlog.warn(`failed to deliver to ${mindName}`, log.errorData(err));
      this.decrementActive(baseName, session);
      publishTypingForChannels(typingMap.deleteSender(baseName), typingMap);
    }
  }

  private async deliverBatchToMind(
    mindName: string,
    session: string,
    messages: QueuedMessage[],
    sessionConfig: ResolvedSessionConfig,
    interruptOverride?: boolean,
  ): Promise<void> {
    const resolved = await this.resolvePort(mindName);
    if (!resolved) {
      dlog.warn(`cannot deliver batch to ${mindName}: mind not found`);
      return;
    }
    const { baseName, port } = resolved;

    // Enrich first message per new channel with participant profiles
    const enrichedMessages = await Promise.all(
      messages.map(async (msg, i) => {
        // Only enrich the first message per unique channel in the batch
        const isFirst = messages.findIndex((m) => m.channel === msg.channel) === i;
        if (!isFirst) return msg;
        const enrichedPayload = await this.enrichWithProfiles(baseName, session, msg.payload);
        return { ...msg, payload: enrichedPayload };
      }),
    );

    // Group messages by channel
    const channels: Record<string, DeliveryPayload[]> = {};
    for (const msg of enrichedMessages) {
      const ch = msg.channel ?? "unknown";
      if (!channels[ch]) channels[ch] = [];
      channels[ch].push(msg.payload);
    }

    // Collect sender/channel metadata from messages
    const senders = new Set<string>();
    const channelSet = new Set<string>();
    for (const msg of messages) {
      if (msg.sender) senders.add(msg.sender);
      if (msg.channel) channelSet.add(msg.channel);
    }

    // Increment active count with metadata
    this.incrementActive(baseName, session, senders, channelSet);

    // Set typing indicators for all real channels in the batch
    const typingMap = getTypingMap();
    for (const ch of Object.keys(channels)) {
      if (ch !== "unknown") typingMap.set(ch, baseName, { persistent: true });
    }
    // Also set on conversationId keys for web UI typing
    const seenConvIds = new Set<string>();
    for (const msg of messages) {
      if (msg.payload.conversationId && !seenConvIds.has(msg.payload.conversationId)) {
        seenConvIds.add(msg.payload.conversationId);
        typingMap.set(msg.payload.conversationId, baseName, { persistent: true });
      }
    }

    const body = JSON.stringify({
      session,
      batch: { channels },
      interrupt: interruptOverride ?? sessionConfig.interrupt,
      instructions: sessionConfig.instructions,
    });

    try {
      const ok = await this.postToMind(port, body);
      if (!ok) {
        this.decrementActive(baseName, session);
        publishTypingForChannels(typingMap.deleteSender(baseName), typingMap);
      } else {
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
      publishTypingForChannels(typingMap.deleteSender(baseName), typingMap);
    }
  }

  private async enqueueBatch(
    mindName: string,
    session: string,
    payload: DeliveryPayload,
    sessionConfig: ResolvedSessionConfig,
  ): Promise<void> {
    const delivery = sessionConfig.delivery as Extract<ResolvedDeliveryMode, { mode: "batch" }>;

    // Check triggers — immediate flush if matched
    if (delivery.triggers?.length) {
      const text = extractTextContent(payload.content);
      const lower = text.toLowerCase();
      if (delivery.triggers.some((t) => lower.includes(t.toLowerCase()))) {
        // Flush existing buffer + this message immediately
        await this.flushBatch(mindName, session, [
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

    // New-speaker interrupt: if mind is active on this channel and a different sender
    // arrives (within the maxWait window and past the debounce cooldown), force-flush
    // with interrupt so the mind can incorporate the new voice
    const baseName = await getBaseName(mindName);
    const state = this.sessionStates.get(baseName)?.get(session);
    if (
      state &&
      state.activeCount > 0 &&
      payload.sender &&
      !state.lastDeliverySenders.has(payload.sender) &&
      payload.channel &&
      state.lastDeliveryChannels.has(payload.channel) &&
      Date.now() - state.lastDeliveredAt < delivery.maxWait * 1000 &&
      Date.now() - state.lastInterruptAt > delivery.debounce * 1000
    ) {
      state.lastInterruptAt = Date.now();
      // Persist to DB (fire-and-forget) and flush immediately with interrupt override
      this.persistToQueue(mindName, session, payload).catch((err) => {
        dlog.warn(`failed to persist batch message for ${mindName}/${session}`, log.errorData(err));
      });
      await this.flushBatch(
        mindName,
        session,
        [{ payload, channel: payload.channel, sender: payload.sender, createdAt: Date.now() }],
        true,
      );
      return;
    }

    // Persist to DB (fire-and-forget): the in-memory buffer is primary for batches,
    // DB persistence is for crash recovery only. Gated messages await because DB is their only store.
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

  private async flushBatch(
    mindName: string,
    session: string,
    extra?: QueuedMessage[],
    interruptOverride?: boolean,
  ): Promise<void> {
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

    const baseName = await getBaseName(mindName);
    const config = getRoutingConfig(baseName);
    const sessionConfig = resolveDeliveryMode(config, session);

    dlog.info(
      `flushing batch for ${mindName}/${session}: ${messages.length} messages${interruptOverride ? " (new-speaker interrupt)" : ""}`,
    );
    this.deliverBatchToMind(mindName, session, messages, sessionConfig, interruptOverride).catch(
      (err) => {
        dlog.warn(`failed to flush batch for ${mindName}/${session}`, log.errorData(err));
      },
    );
  }

  private async gateMessage(
    mindName: string,
    session: string,
    payload: DeliveryPayload,
  ): Promise<void> {
    const baseName = await getBaseName(mindName);
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

    const { sendSystemMessage } = await import("../system-chat.js");
    await sendSystemMessage(mindName, notification);
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

  private async enrichWithProfiles(
    mindName: string,
    session: string,
    payload: DeliveryPayload,
  ): Promise<DeliveryPayload> {
    if (!payload.conversationId || !payload.channel) return payload;
    const mindSessions = this.sessionStates.get(mindName);
    const state = mindSessions?.get(session);
    if (!state) return payload;

    const channelKey = payload.channel;
    if (state.seenChannelProfiles.has(channelKey)) return payload;

    try {
      const participants = await getParticipants(payload.conversationId);
      const profiles: ParticipantProfile[] = participants.map((p) => ({
        username: p.username,
        userType: p.userType,
        displayName: p.displayName,
        description: p.description,
      }));

      // Read avatar images and prepend as image blocks
      const avatarBlocks = await this.loadAvatarBlocks(participants);

      state.seenChannelProfiles.add(channelKey);
      const enriched: DeliveryPayload = { ...payload, participantProfiles: profiles };
      if (avatarBlocks.length > 0) {
        const existing = Array.isArray(payload.content)
          ? payload.content
          : typeof payload.content === "string"
            ? [{ type: "text" as const, text: payload.content }]
            : [];
        enriched.content = [...avatarBlocks, ...existing];
      }
      return enriched;
    } catch (err) {
      dlog.warn(`failed to fetch participant profiles for ${mindName}`, log.errorData(err));
      return payload;
    }
  }

  private async loadAvatarBlocks(
    participants: { username: string; userType: string; avatar?: string | null }[],
  ): Promise<
    ({ type: "text"; text: string } | { type: "image"; media_type: string; data: string })[]
  > {
    const blocks: (
      | { type: "text"; text: string }
      | { type: "image"; media_type: string; data: string }
    )[] = [];

    for (const p of participants) {
      if (!p.avatar) continue;

      try {
        let filePath: string;
        if (p.userType === "mind") {
          const dir = mindDir(p.username);
          const config = readVoluteConfig(dir);
          if (!config?.profile?.avatar) continue;
          filePath = resolve(dir, "home", config.profile.avatar);
          const homeDir = resolve(dir, "home");
          if (!filePath.startsWith(`${homeDir}/`)) {
            dlog.warn(`avatar path for ${p.username} escapes home directory, skipping`);
            continue;
          }
          try {
            const realHome = await realpath(homeDir);
            const realAvatar = await realpath(filePath);
            if (!realAvatar.startsWith(`${realHome}/`)) {
              dlog.warn(
                `avatar symlink for ${p.username} resolves outside home directory, skipping`,
              );
              continue;
            }
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
            throw err;
          }
        } else {
          filePath = resolve(voluteHome(), "avatars", p.avatar);
        }

        const ext = extname(filePath).toLowerCase();
        const mimeMap: Record<string, string> = {
          ".png": "image/png",
          ".jpg": "image/jpeg",
          ".jpeg": "image/jpeg",
          ".gif": "image/gif",
          ".webp": "image/webp",
        };
        const mediaType = mimeMap[ext];
        if (!mediaType) continue;

        const data = await readFile(filePath);
        let imageData: Buffer = data;
        try {
          const sharpMod = await import("sharp");
          imageData = await sharpMod.default(data).resize(128, 128, { fit: "cover" }).toBuffer();
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === "MODULE_NOT_FOUND" || code === "ERR_MODULE_NOT_FOUND") {
            dlog.debug("sharp not available, sending full-size avatar");
          } else {
            dlog.warn(
              `avatar resize failed for ${p.username}, sending original`,
              log.errorData(err),
            );
          }
        }
        blocks.push(
          { type: "text", text: `[Avatar for ${p.username}]` },
          { type: "image", media_type: mediaType, data: imageData.toString("base64") },
        );
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") {
          dlog.warn(`failed to load avatar for ${p.username}`, log.errorData(err));
        }
      }
    }

    return blocks;
  }

  private incrementActive(
    mind: string,
    session: string,
    senders?: Set<string>,
    channels?: Set<string>,
  ): void {
    let mindSessions = this.sessionStates.get(mind);
    if (!mindSessions) {
      mindSessions = new Map();
      this.sessionStates.set(mind, mindSessions);
    }
    const state = mindSessions.get(session) ?? {
      activeCount: 0,
      lastDeliveredAt: 0,
      lastDeliverySenders: new Set<string>(),
      lastDeliveryChannels: new Set<string>(),
      lastInterruptAt: 0,
      seenChannelProfiles: new Set<string>(),
    };
    state.activeCount++;
    state.lastDeliveredAt = Date.now();
    if (senders) state.lastDeliverySenders = senders;
    if (channels) state.lastDeliveryChannels = channels;
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
  if (instance) throw new Error("DeliveryManager already initialized");
  instance = new DeliveryManager();
  return instance;
}

export function getDeliveryManager(): DeliveryManager {
  if (!instance) {
    throw new Error("DeliveryManager not initialized — call initDeliveryManager() first");
  }
  return instance;
}
