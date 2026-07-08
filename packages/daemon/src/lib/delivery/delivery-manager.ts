import { readFile, realpath } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { and, eq, inArray, sql } from "drizzle-orm";
import { getTypingMap, publishTypingForChannels } from "../chat/typing.js";
import { tryGetMindManager } from "../daemon/mind-manager.js";
import { linkInboundToActiveTurn } from "../daemon/turn-tracker.js";
import { getDb } from "../db.js";
import { getParticipants } from "../events/conversations.js";
import { onMindEvent } from "../events/mind-activity-tracker.js";
import { findMind, getBaseName, mindDir, voluteHome } from "../mind/registry.js";
import { readVoluteConfig } from "../mind/volute-config.js";
import { deliveryQueue } from "../schema.js";
import log from "../util/logger.js";
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
  setRoutesChangeListener,
} from "./delivery-router.js";
import { clearMind, onDeliveredToMind, resetTurn } from "./send-gate.js";

const dlog = log.child("delivery-manager");

const MAX_BATCH_SIZE = 50;

// --- Redrive / retry tuning ---
const REDRIVE_INTERVAL_MS = 15_000;
const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 5 * 60_000;
const REDRIVE_BATCH_LIMIT = 200;

const mentionRegexCache = new Map<string, RegExp>();

type AvatarBlock =
  | { type: "text"; text: string }
  | { type: "image"; media_type: string; data: string };
type AvatarCacheEntry = { blocks: AvatarBlock[]; expiresAt: number };
const avatarBlocksCache = new Map<string, AvatarCacheEntry>();
const AVATAR_CACHE_TTL = 5 * 60 * 1000;

// --- Session state tracking ---

type SessionState = {
  activeCount: number;
  lastDeliveredAt: number;
  lastDeliverySenders: Set<string>;
  lastDeliveryChannels: Set<string>;
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
  /** delivery_queue row id backing this message (source of truth). */
  queueId?: number;
};

// --- Delivery Manager ---

export class DeliveryManager {
  private sessionStates = new Map<string, Map<string, SessionState>>();
  private batchBuffers = new Map<string, BatchBuffer>();

  /**
   * delivery_queue row ids currently owned in-memory — either buffered in a batch
   * buffer or actively being POSTed. The redrive sweep skips these so it never
   * double-delivers a row that the normal path is already handling.
   */
  private inFlight = new Set<number>();

  /**
   * Per-`(baseName:session)` promise chain that serializes POSTs so two rapid
   * messages to the same session can't be reordered by resolvePort/enrichment latency.
   */
  private drainChains = new Map<string, Promise<unknown>>();

  private redriveTimer: ReturnType<typeof setInterval> | null = null;

  /** Predicate for whether a mind is up; overridable in tests. */
  private isMindRunning: (baseName: string) => boolean = (name) =>
    tryGetMindManager()?.isRunning(name) ?? false;

  constructor() {
    // Release gated messages when a mind's routes.json changes.
    setRoutesChangeListener((mind) => {
      this.releaseGated(mind).catch((err) =>
        dlog.warn(`failed to release gated messages for ${mind}`, log.errorData(err)),
      );
    });
  }

  /** Test seam: override the mind-running predicate. */
  setRunningCheck(fn: (baseName: string) => boolean): void {
    this.isMindRunning = fn;
  }

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
      const queueId = await this.persistToQueue(mindName, sessionName, payload);
      await this.deliverToMind(mindName, sessionName, payload, sessionConfig, queueId);
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
      let pattern = mentionRegexCache.get(baseName);
      if (!pattern) {
        const escaped = baseName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        pattern = new RegExp(`\\b${escaped}\\b`, "i");
        mentionRegexCache.set(baseName, pattern);
      }
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

    // Inbound-to-turn linking happens deterministically at turn creation (see
    // TurnLifecycle.linkPendingInbound), scoped by the turn's session and channel, so
    // no proactive time-window tagging is needed here.

    // Resolve delivery mode for this session (pass matched rule for rule-level batch config)
    const sessionConfig = resolveDeliveryMode(config, sessionName, route.rule);

    if (sessionConfig.delivery.mode === "batch") {
      dlog.debug(`enqueueing batch message for ${mindName}/${sessionName}`);
      await this.enqueueBatch(mindName, sessionName, payload, sessionConfig);
      return { routed: true, session: sessionName, destination: "mind", mode: "batch" };
    }

    // Immediate delivery — persist to the queue BEFORE the POST so a crash or a
    // failed POST leaves an at-least-once record the redrive loop can re-deliver.
    const queueId = await this.persistToQueue(mindName, sessionName, payload);
    await this.deliverToMind(mindName, sessionName, payload, sessionConfig, queueId);
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
    // A completed turn closes the mind's stale-send baselines so the next delivery re-snapshots.
    resetTurn(baseName);
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
   * Restore queued messages from DB on daemon restart — a single redrive pass.
   * All accepted deliveries are persisted to delivery_queue before their POST and
   * only deleted on mind-ack, so pending rows are exactly the undelivered messages.
   */
  async restoreFromDb(): Promise<void> {
    await this.redrive();
  }

  /** Start the periodic redrive sweep (idempotent). */
  startRedrive(): void {
    if (this.redriveTimer) return;
    this.redriveTimer = setInterval(() => {
      this.redrive().catch((err) => dlog.warn("redrive sweep failed", log.errorData(err)));
    }, REDRIVE_INTERVAL_MS);
    this.redriveTimer.unref();
  }

  /**
   * Re-read pending delivery_queue rows that are eligible (past their backoff window)
   * and re-deliver them through the normal path. Rows already owned in-memory
   * (`inFlight`) and minds that are down are skipped so we never hot-loop or double-send.
   */
  async redrive(): Promise<void> {
    let rows: (typeof deliveryQueue.$inferSelect)[];
    try {
      const db = await getDb();
      rows = await db
        .select()
        .from(deliveryQueue)
        .where(
          and(
            eq(deliveryQueue.status, "pending"),
            sql`(${deliveryQueue.next_attempt_at} IS NULL OR ${deliveryQueue.next_attempt_at} <= datetime('now'))`,
          ),
        )
        .orderBy(deliveryQueue.id)
        .limit(REDRIVE_BATCH_LIMIT);
    } catch (err) {
      dlog.warn("failed to read delivery queue for redrive", log.errorData(err));
      return;
    }

    let redriven = 0;
    for (const row of rows) {
      if (this.inFlight.has(row.id)) continue;
      if (!this.isMindRunning(row.mind)) continue;

      let payload: DeliveryPayload;
      try {
        payload = JSON.parse(row.payload) as DeliveryPayload;
      } catch (parseErr) {
        dlog.warn(
          `corrupt payload in delivery queue row ${row.id}, dropping`,
          log.errorData(parseErr),
        );
        await this.deleteQueueRows([row.id]);
        continue;
      }

      const config = getRoutingConfig(row.mind);
      const sessionConfig = resolveDeliveryMode(config, row.session);

      // Resolve delivery from the original target (may be a variant) — the `mind`
      // column is the base name, used only for keying/cleanup. Falls back to `mind`
      // for legacy rows with no recorded target.
      const target = row.target_mind ?? row.mind;

      if (sessionConfig.delivery.mode === "batch") {
        this.inFlight.add(row.id);
        this.addToBatchBuffer(target, row.session, sessionConfig, {
          payload,
          channel: payload.channel,
          sender: payload.sender ?? null,
          createdAt: Date.now(),
          queueId: row.id,
        });
      } else {
        this.deliverToMind(target, row.session, payload, sessionConfig, row.id).catch((err) => {
          dlog.warn(`failed to redrive delivery for ${target}`, log.errorData(err));
        });
      }
      redriven++;
    }

    if (redriven > 0) dlog.info(`redrove ${redriven} pending delivery queue rows`);
  }

  /**
   * Re-evaluate a mind's `gated` rows against its current routes.json and promote any
   * that now match to `pending` (delivered by the next redrive sweep). Called when the
   * routing config changes.
   */
  async releaseGated(mindName: string): Promise<void> {
    const baseName = await getBaseName(mindName);
    const config = getRoutingConfig(baseName);
    let rows: (typeof deliveryQueue.$inferSelect)[];
    try {
      const db = await getDb();
      rows = await db
        .select()
        .from(deliveryQueue)
        .where(and(eq(deliveryQueue.mind, baseName), eq(deliveryQueue.status, "gated")));
    } catch (err) {
      dlog.warn(`failed to read gated rows for ${baseName}`, log.errorData(err));
      return;
    }

    const promote: number[] = [];
    for (const row of rows) {
      let payload: DeliveryPayload;
      try {
        payload = JSON.parse(row.payload) as DeliveryPayload;
      } catch {
        continue;
      }
      const meta: MatchMeta = {
        channel: payload.channel,
        sender: payload.sender ?? undefined,
        isDM: payload.isDM,
        participantCount: payload.participantCount,
      };
      const route = resolveRoute(config, meta);
      if (route.matched && route.destination === "mind") {
        promote.push(row.id);
      }
    }

    if (promote.length === 0) return;
    try {
      const db = await getDb();
      await db
        .update(deliveryQueue)
        .set({ status: "pending", attempts: 0, next_attempt_at: null })
        .where(inArray(deliveryQueue.id, promote));
      dlog.info(`released ${promote.length} gated message(s) for ${baseName} after route change`);
    } catch (err) {
      dlog.warn(`failed to promote gated rows for ${baseName}`, log.errorData(err));
      return;
    }
    // Deliver immediately rather than waiting for the next sweep.
    await this.redrive();
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
    // Free the mind's stale-send gate state so it doesn't linger after stop.
    clearMind(mindName);
    // Clean up any batch buffers for this mind
    const toDelete: string[] = [];
    for (const [bufferKey, buffer] of this.batchBuffers) {
      if (bufferKey.startsWith(`${mindName}:`)) {
        if (buffer.debounceTimer) clearTimeout(buffer.debounceTimer);
        if (buffer.maxWaitTimer) clearTimeout(buffer.maxWaitTimer);
        // Release ownership of the buffered rows: their persisted queue rows remain
        // pending, so the redrive loop can re-deliver them once the mind is back.
        for (const msg of buffer.messages) {
          if (msg.queueId != null) this.inFlight.delete(msg.queueId);
        }
        toDelete.push(bufferKey);
      }
    }
    for (const k of toDelete) this.batchBuffers.delete(k);
  }

  /**
   * Reset a single session's leaked active count back to zero.
   *
   * Used by the wedged-turn sweep: when a session's `activeCount` drifts above zero
   * (deliveries outnumbering `done`s) it gates turn completion indefinitely. Once the sweep
   * confirms the session is genuinely idle, this clears the stale count so the next turn
   * can complete normally. Batch buffers are left intact — their own maxWait timer flushes
   * any pending messages.
   *
   * `minIdleMs` guards against a race: if a delivery landed within that window, a fresh turn
   * may legitimately be in flight (real `activeCount`), so zeroing would complete it early.
   * In that case we skip — the next sweep retries if it's still wedged. Returns whether the
   * count was reset.
   */
  clearSessionActive(mindName: string, session: string, minIdleMs: number): boolean {
    const state = this.sessionStates.get(mindName)?.get(session);
    if (!state) return false;
    if (Date.now() - state.lastDeliveredAt < minIdleMs) return false;
    state.activeCount = 0;
    return true;
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
    this.inFlight.clear();
    this.drainChains.clear();
    if (this.redriveTimer) {
      clearInterval(this.redriveTimer);
      this.redriveTimer = null;
    }
    setRoutesChangeListener(undefined);
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

  /**
   * Serialize `fn` on a per-key promise chain so calls for the same key run one at a
   * time in submission order. Used to drain a `(mind, session)` sequentially.
   */
  private runSequential<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.drainChains.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.then(
      () => {},
      () => {},
    );
    this.drainChains.set(key, tail);
    tail.then(() => {
      if (this.drainChains.get(key) === tail) this.drainChains.delete(key);
    });
    return run;
  }

  /** Delete delivered queue rows by their specific ids. */
  private async deleteQueueRows(ids: (number | undefined)[]): Promise<void> {
    const valid = [...new Set(ids.filter((id): id is number => typeof id === "number"))];
    if (valid.length === 0) return;
    try {
      const db = await getDb();
      await db.delete(deliveryQueue).where(inArray(deliveryQueue.id, valid));
    } catch (err) {
      dlog.warn("failed to delete delivered delivery queue rows", log.errorData(err));
    }
  }

  /** Bump attempt counters and set a backoff window so a down mind isn't hot-looped. */
  private async scheduleRetry(ids: (number | undefined)[]): Promise<void> {
    const valid = [...new Set(ids.filter((id): id is number => typeof id === "number"))];
    if (valid.length === 0) return;
    try {
      const db = await getDb();
      const rows = await db
        .select({ id: deliveryQueue.id, attempts: deliveryQueue.attempts })
        .from(deliveryQueue)
        .where(inArray(deliveryQueue.id, valid));
      for (const row of rows) {
        const attempts = row.attempts + 1;
        const backoffSec = Math.round(
          Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(attempts, 20)) / 1000,
        );
        await db
          .update(deliveryQueue)
          .set({ attempts, next_attempt_at: sql`datetime('now', ${`+${backoffSec} seconds`})` })
          .where(eq(deliveryQueue.id, row.id));
      }
    } catch (err) {
      dlog.warn("failed to schedule delivery retry", log.errorData(err));
    }
  }

  private async deliverToMind(
    mindName: string,
    session: string,
    payload: DeliveryPayload,
    sessionConfig: ResolvedSessionConfig,
    queueId?: number,
  ): Promise<void> {
    if (queueId != null) this.inFlight.add(queueId);

    // Serialize the ENTIRE delivery (resolvePort + enrichment + POST) per
    // (mind, session) so resolvePort/enrichment latency can't reorder two rapid
    // messages — they POST in submission order.
    await this.runSequential(`${mindName}:${session}`, async () => {
      const resolved = await this.resolvePort(mindName);
      if (!resolved) {
        // Mind not found/running — leave the persisted row pending for the redrive loop.
        dlog.warn(`cannot deliver to ${mindName}: mind not found`);
        if (queueId != null) this.inFlight.delete(queueId);
        return;
      }
      const { baseName, port } = resolved;

      // Increment active count before delivery with sender/channel metadata
      const senders = new Set<string>();
      if (payload.sender) senders.add(payload.sender);
      const channels = new Set<string>();
      if (payload.channel) channels.add(payload.channel);
      this.incrementActive(baseName, session, senders, channels);

      // Snapshot the stale-send baseline: the latest message this mind has now seen in
      // the conversation, so a reply it composes can be held if a peer posts after this.
      // Awaited so the baseline is set before the mind can receive-and-reply.
      await onDeliveredToMind(baseName, payload.conversationId);

      // If a turn is already in progress for this session, attribute this mid-turn inbound to
      // it now. linkPendingInbound only tags at turn creation (bounded sweep), so without this
      // a batched message arriving mid-turn — or a >5 backlog — would stay untagged.
      // No-op when no turn is active yet; the turn-creation path tags the trigger then.
      linkInboundToActiveTurn(baseName, session, payload.channel).catch((err) =>
        dlog.warn(`failed to link mid-turn inbound for ${baseName}`, log.errorData(err)),
      );

      // Set typing indicator on both slug and conversationId keys
      const typingMap = getTypingMap();
      if (payload.channel) {
        typingMap.set(payload.channel, baseName, { persistent: true });
      }
      if (payload.conversationId) {
        typingMap.set(payload.conversationId, baseName, { persistent: true });
      }

      // Mark mind as active immediately at delivery time (before it emits events)
      onMindEvent(baseName, "delivery", payload.channel);

      // Enrich with participant profiles on first encounter per channel
      const enrichedPayload = await this.enrichWithProfiles(baseName, session, payload);

      const body = JSON.stringify({
        ...enrichedPayload,
        session,
        instructions: sessionConfig.instructions,
      });

      try {
        const ok = await this.postToMind(port, body);
        if (!ok) {
          this.decrementActive(baseName, session);
          publishTypingForChannels(typingMap.deleteSender(baseName), typingMap);
          await this.scheduleRetry([queueId]);
        } else {
          // Mark delivered ONLY on ack, by specific row id — never a broad DELETE.
          await this.deleteQueueRows([queueId]);
        }
      } catch (err) {
        dlog.warn(`failed to deliver to ${mindName}`, log.errorData(err));
        this.decrementActive(baseName, session);
        publishTypingForChannels(typingMap.deleteSender(baseName), typingMap);
        await this.scheduleRetry([queueId]);
      } finally {
        if (queueId != null) this.inFlight.delete(queueId);
      }
    });
  }

  private async deliverBatchToMind(
    mindName: string,
    session: string,
    messages: QueuedMessage[],
    sessionConfig: ResolvedSessionConfig,
  ): Promise<void> {
    const queueIds = messages
      .map((m) => m.queueId)
      .filter((id): id is number => typeof id === "number");

    // Serialize the whole batch delivery per (mind, session) so it can't be
    // reordered against interleaving immediate deliveries to the same session.
    await this.runSequential(`${mindName}:${session}`, async () => {
      const resolved = await this.resolvePort(mindName);
      if (!resolved) {
        dlog.warn(`cannot deliver batch to ${mindName}: mind not found`);
        // Leave rows pending for redrive; release ownership so the sweep can retry.
        for (const id of queueIds) this.inFlight.delete(id);
        return;
      }
      const { baseName, port } = resolved;

      // Enrich first message per new channel with participant profiles
      const firstPerChannel = new Set<string>();
      const isFirstForChannel: boolean[] = [];
      for (const msg of messages) {
        const ch = msg.channel ?? "unknown";
        isFirstForChannel.push(!firstPerChannel.has(ch));
        firstPerChannel.add(ch);
      }
      const enrichedMessages = await Promise.all(
        messages.map(async (msg, i) => {
          if (!isFirstForChannel[i]) return msg;
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

      // Snapshot the stale-send baseline per conversation in this batch (see deliverToMind).
      const convIds = new Set<string>();
      for (const msg of messages) {
        if (msg.payload.conversationId) convIds.add(msg.payload.conversationId);
      }
      for (const convId of convIds) {
        await onDeliveredToMind(baseName, convId);
      }

      // Attribute any mid-turn inbounds in this batch to an in-progress turn (see deliverToMind).
      for (const ch of channelSet) {
        linkInboundToActiveTurn(baseName, session, ch).catch((err) =>
          dlog.warn(`failed to link mid-turn inbound for ${baseName}`, log.errorData(err)),
        );
      }

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
        instructions: sessionConfig.instructions,
      });

      try {
        const ok = await this.postToMind(port, body);
        if (!ok) {
          this.decrementActive(baseName, session);
          publishTypingForChannels(typingMap.deleteSender(baseName), typingMap);
          await this.scheduleRetry(queueIds);
        } else {
          // Mark delivered ONLY on ack, and ONLY the specific rows in this batch —
          // a broad (mind, session, pending) DELETE would race with rows enqueued
          // concurrently during the flush.
          await this.deleteQueueRows(queueIds);
        }
      } catch (err) {
        dlog.warn(`failed to deliver batch to ${mindName}`, log.errorData(err));
        this.decrementActive(baseName, session);
        publishTypingForChannels(typingMap.deleteSender(baseName), typingMap);
        await this.scheduleRetry(queueIds);
      } finally {
        for (const id of queueIds) this.inFlight.delete(id);
      }
    });
  }

  private async enqueueBatch(
    mindName: string,
    session: string,
    payload: DeliveryPayload,
    sessionConfig: ResolvedSessionConfig,
  ): Promise<void> {
    const delivery = sessionConfig.delivery as Extract<ResolvedDeliveryMode, { mode: "batch" }>;

    // Persist to the queue FIRST — the row is the source of truth; the in-memory buffer is
    // a fast path reconciled against these rows on ack/redrive. The row is "owned" (inFlight)
    // while buffered so the redrive sweep won't double-send.
    const queueId = await this.persistToQueue(mindName, session, payload);
    if (queueId != null) this.inFlight.add(queueId);
    const msg: QueuedMessage = {
      payload,
      channel: payload.channel,
      sender: payload.sender ?? null,
      createdAt: Date.now(),
      queueId,
    };

    // Check triggers — immediate flush if matched
    if (delivery.triggers?.length) {
      const text = extractTextContent(payload.content);
      const lower = text.toLowerCase();
      if (delivery.triggers.some((t) => lower.includes(t.toLowerCase()))) {
        // Flush existing buffer + this message immediately
        await this.flushBatch(mindName, session, [msg]);
        return;
      }
    }

    this.addToBatchBuffer(mindName, session, sessionConfig, msg);
  }

  private addToBatchBuffer(
    mindName: string,
    session: string,
    sessionConfig: ResolvedSessionConfig,
    msg: QueuedMessage,
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

    buffer.messages.push(msg);

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
    const baseName = await getBaseName(mindName);
    await this.persistToQueue(mindName, session, payload, "gated");

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
      `Someone new is reaching out — you don't have a route for this channel yet.`,
      `Sender: ${payload.sender ?? "unknown"}`,
      payload.platform ? `Platform: ${payload.platform}` : null,
      payload.participantCount ? `Participants: ${payload.participantCount}` : null,
      "",
      `Preview: ${preview}`,
      "",
      `To start hearing this channel, add a routing rule for "${channel}" to .config/routes.json.`,
      `Messages are held safely until you do — nothing is lost. If you'd rather not engage, just leave it unrouted.`,
    ]
      .filter((line) => line !== null)
      .join("\n");

    const { sendSystemMessage } = await import("../chat/system-chat.js");
    await sendSystemMessage(mindName, notification);
  }

  /**
   * Insert a delivery_queue row and return its id. The `mind` column is always keyed by
   * `baseName` so inserts under a variant name and the id-scoped cleanup use the same key
   * (fixes the variant mismatch where variant-keyed rows were never matched by the base
   * cleanup). `target_mind` records the original delivery target (`mindName`, which may be a
   * variant) so redrive resolves the port from it — a variant's stranded row is re-delivered
   * to the variant, not the parent.
   */
  private async persistToQueue(
    mindName: string,
    session: string,
    payload: DeliveryPayload,
    status: "pending" | "gated" = "pending",
  ): Promise<number | undefined> {
    try {
      const baseName = await getBaseName(mindName);
      const db = await getDb();
      const result = await db
        .insert(deliveryQueue)
        .values({
          mind: baseName,
          target_mind: mindName,
          session,
          channel: payload.channel ?? null,
          sender: payload.sender ?? null,
          status,
          payload: JSON.stringify(payload),
        })
        .returning({ id: deliveryQueue.id });
      return result[0]?.id;
    } catch (err) {
      dlog.warn(
        `failed to persist to delivery queue for ${mindName}/${session}`,
        log.errorData(err),
      );
      return undefined;
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
  ): Promise<AvatarBlock[]> {
    const cacheKey = participants
      .map((p) => `${p.username}:${p.avatar ?? ""}`)
      .sort()
      .join(",");
    const cached = avatarBlocksCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.blocks;

    const blocks: AvatarBlock[] = [];

    let sharpDefault: any = null;
    try {
      const mod = await import("sharp");
      sharpDefault = mod.default ?? mod;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "MODULE_NOT_FOUND" || code === "ERR_MODULE_NOT_FOUND") {
        dlog.debug("sharp not available, sending full-size avatars");
      } else {
        dlog.warn("sharp import failed, sending full-size avatars", log.errorData(err));
      }
    }

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
        if (sharpDefault) {
          try {
            imageData = await sharpDefault(data).resize(128, 128, { fit: "cover" }).toBuffer();
          } catch (err) {
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

    // Evict expired entries on insert. The map holds base64 image blocks keyed by
    // participant-set permutation; without this sweep every distinct membership
    // combination leaves a permanent entry. TTL-on-read alone never frees them.
    const now = Date.now();
    for (const [key, entry] of avatarBlocksCache) {
      if (entry.expiresAt <= now) avatarBlocksCache.delete(key);
    }
    avatarBlocksCache.set(cacheKey, { blocks, expiresAt: now + AVATAR_CACHE_TTL });
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
      } else if (session.startsWith("new-")) {
        // Ephemeral $new sessions get a unique name per message and never recur,
        // so their state would accumulate forever. Reclaim it once idle. Long-lived
        // named sessions keep their entry (bounded by routing config).
        mindSessions.delete(session);
        if (mindSessions.size === 0) this.sessionStates.delete(mind);
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

/** Like getDeliveryManager but returns undefined instead of throwing when uninitialized. */
export function tryGetDeliveryManager(): DeliveryManager | undefined {
  return instance;
}
