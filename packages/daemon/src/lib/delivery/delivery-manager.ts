import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { isMind } from "@volute/api/user-type";
import { and, eq, inArray, sql } from "drizzle-orm";
import { MIND_LEVEL_THREAD, type RecordNoticeInput } from "../chat/system-events.js";
import { getTypingMap, publishTypingForChannels } from "../chat/typing.js";
import { tryGetMindManager } from "../daemon/mind-manager.js";
import { linkInboundToActiveTurn } from "../daemon/turn-tracker.js";
import { getDb } from "../db.js";
import { getChannelName, getChannelSettings, getParticipants } from "../events/conversations.js";
import { onMindEvent } from "../events/mind-activity-tracker.js";
import { publish as publishMindEvent } from "../events/mind-events.js";
import { findMind, getBaseName, mindDir, voluteHome } from "../mind/registry.js";
import { readVoluteConfig } from "../mind/volute-config.js";
import { channelGates, channels, deliveryQueue, mindHistory } from "../schema.js";
import { type AvatarBlock, renderAvatarBlock } from "../util/avatar-image.js";
import log from "../util/logger.js";
import { newEphemeralSession } from "../util/session-name.js";
import { slugify } from "../util/slugify.js";
import {
  type ChannelContext,
  clearConfigCache,
  type DeliveryPayload,
  extractTextContent,
  getRoutingConfig,
  type MatchMeta,
  type ParticipantProfile,
  type ResolvedDeliveryMode,
  type ResolvedSessionConfig,
  type RoutingConfig,
  resolveDeliveryMode,
  resolveRoute,
  routesConfigPath,
  setRoutesChangeListener,
  shouldGate,
} from "./delivery-router.js";
import { clearMind, onDeliveredToMind, resetTurn } from "./send-gate.js";

const dlog = log.child("delivery-manager");

const MAX_BATCH_SIZE = 50;

/**
 * Loose key for comparing a channel name someone typed against the real slugs they could
 * have meant: case-insensitive, leading sigil dropped. `#garden`, `garden` and `Garden`
 * all collapse to `garden`.
 */
function normalizeChannelKey(channel: string): string {
  return channel.replace(/^[#@]/, "").toLowerCase();
}

/**
 * Quote and join candidate slugs for a "did you mean" message. One candidate reads as a
 * plain question (`"#alice"`) rather than a list of one; two or more are spelled out in
 * full, because naming only the first would be a confident answer to an open question.
 */
export function formatSuggestions(suggestions: string[]): string {
  const quoted = suggestions.map((s) => `"${s}"`);
  if (quoted.length <= 1) return quoted.join("");
  if (quoted.length === 2) return `${quoted[0]} or ${quoted[1]}`;
  return `${quoted.slice(0, -1).join(", ")}, or ${quoted[quoted.length - 1]}`;
}

/**
 * A channel name that matches nothing, where something close does exist. Carries its own
 * type rather than relying on the caller sniffing `err.message`: #778 flagged that
 * string-matching pattern as fragile ("a reworded message silently changes the status
 * code") and this is the third site that would have used it, so it's worth doing properly.
 *
 * Carries *every* near-miss, not the closest one. `normalizeChannelKey` strips the sigil,
 * so a DM `@alice` and a channel `#alice` both match a bare `alice` — and picking one
 * would have meant picking by ASCII order (`#` is 0x23, `@` is 0x40), then presenting that
 * accident as an answer. Naming both is the honest reply to an ambiguous name.
 */
export class UnknownChannelError extends Error {
  constructor(
    readonly channel: string,
    readonly suggestions: string[],
  ) {
    super(
      `no channel named "${channel}" — did you mean ${formatSuggestions(suggestions)}? ` +
        `(quote it: the shell strips an unquoted #name)`,
    );
    this.name = "UnknownChannelError";
  }
}

// --- Redrive / retry tuning ---
const REDRIVE_INTERVAL_MS = 15_000;
const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 5 * 60_000;
const REDRIVE_BATCH_LIMIT = 200;
// After this many failed POST attempts a row is dead-lettered (status "dead") instead of
// retried forever. With the backoff above (capped at 5 min) this is ~30 min of retries —
// enough to ride out a mind restart or transient fault, but bounded so a payload the mind
// permanently rejects can't grow the queue without limit. #356
export const MAX_DELIVERY_ATTEMPTS = 10;

// --- Gated-channel release tuning ---
// When a routing change matches a previously-gated channel, deliver at most this many
// of the newest held messages per channel. The rest are archived (inert) so a
// months-old backlog can't flood the mind's context in a single sweep. #537
const GATED_RELEASE_LIMIT_PER_CHANNEL = 10;
// Re-send the "new channel" invite every N held messages, not just on the first. A
// mind should be able to tell "nobody is talking to me" from "I've been deaf for
// months". #537
const GATED_NOTIFY_EVERY = 10;
// Most-recent messages returned by a peek. Peeking is how a mind decides whether to accept
// a channel; dumping an unbounded backlog into its context to answer that would defeat the
// point of gating in the first place. The true total is reported alongside.
const PEEK_LIMIT = 50;

const mentionRegexCache = new Map<string, RegExp>();

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
  /**
   * Channel key → the `updated_at` of the settings last announced to this session. Separate
   * from seenChannelProfiles so a settings change re-announces the channel's card without
   * re-sending every participant profile and avatar, and so a failed read doesn't count as
   * "already introduced".
   */
  announcedChannelInfo: Map<string, string>;
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

/**
 * A reason to hold a delivery instead of POSTing it. A hold is a *scheduling* decision,
 * not a delivery failure: the row stays `pending` with its attempt count untouched and no
 * backoff, so the redrive sweep re-offers it every pass and it goes out the moment the
 * reason clears. Nothing is dropped and nothing is dead-lettered.
 *
 * `reason` is an open string so a second, independent reason to hold can be added without
 * touching this file — the concurrency gate proposed in #823 wants the same choke point,
 * and one gate with two reasons is better than two gates racing each other.
 */
export type DeliveryHold = { reason: string; scope: "mind" | "system" };

/** Local `YYYY-MM-DD HH:MM`, for a held message telling a mind when it actually arrived. */
function compactLocal(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

/**
 * Render a held message's wait into its content, and strip the marker so it never reaches
 * the mind as a raw field.
 *
 * The preface goes into `content` — not into a new payload field — because every template
 * already renders content verbatim, while a new field would be silently dropped by every
 * mind that hasn't run `volute mind upgrade`. A message that waited hours and arrives
 * looking brand new is a small lie told to exactly the minds least equipped to catch it.
 *
 * It claims only what is true in every release path. A hold ends when the period resets,
 * but also when a host raises or clears the cap, so the line says the message waited and
 * is arriving now, and does not assert why it stopped waiting.
 */
export function withHeldPreface(payload: DeliveryPayload): DeliveryPayload {
  const held = payload.held;
  if (!held) return payload;
  const { held: _marker, ...rest } = payload;
  const whose = held.scope === "system" ? "this install's spend cap" : "your spend cap";
  const line =
    `[held — this arrived at ${compactLocal(held.at)}, when ${whose} was reached, ` +
    `and waited rather than reaching you then. It is reaching you now.]`;
  if (typeof rest.content === "string") {
    return { ...rest, content: `${line}\n${rest.content}` };
  }
  if (Array.isArray(rest.content)) {
    return { ...rest, content: [{ type: "text", text: line }, ...rest.content] };
  }
  return rest;
}

/** The delivery_queue fields a dead-lettered row carries into its failure notice. */
type DeadLetterRow = {
  id: number;
  mind: string;
  target_mind: string | null;
  thread: string;
  channel: string | null;
  sender: string | null;
  created_at: string;
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

  /**
   * Per-`baseName` promise chain that serializes gated releases. `releaseGated` reads gated
   * rows and then writes `mind_history`; the promote UPDATE is idempotent but the history
   * INSERT is not, so two overlapping runs would record the same message twice.
   */
  private releaseChains = new Map<string, Promise<void>>();

  /**
   * Per-`baseName` promise chain serializing accepts, whose read-modify-write of
   * routes.json would otherwise lose a rule when two run concurrently.
   */
  private acceptChains = new Map<string, Promise<void>>();

  private redriveTimer: ReturnType<typeof setInterval> | null = null;

  /** Predicate for whether a mind is up; overridable in tests. */
  /**
   * Whether a delivery to this (mind, session) must wait. Injected rather than imported so
   * `delivery/` stays free of a dependency on the spend budget (and, later, on whatever
   * else wants to hold — #823's concurrency gate is the next one).
   */
  private holdCheck: (baseName: string, session: string) => DeliveryHold | null = () => null;

  private isMindRunning: (baseName: string) => boolean = (name) =>
    tryGetMindManager()?.isRunning(name) ?? false;

  /** Delivers a channel event to a mind (invites, release summaries); overridable in tests. */
  private notify: (mindName: string, text: string) => Promise<void> = async (mindName, text) => {
    const { deliverEvent } = await import("../chat/system-events.js");
    await deliverEvent(mindName, { type: "channel", body: text });
  };

  /** Surfaces a dead-lettered delivery as a next-turn failure notice; overridable in tests. */
  private notifyFailure: (input: RecordNoticeInput) => Promise<void> = async (input) => {
    const { recordNotice } = await import("../chat/system-events.js");
    await recordNotice(input);
  };

  /**
   * Tells a mind *sender* its message was dropped (dead-lettered on the recipient's
   * side); no-ops for human senders. Overridable in tests.
   */
  private notifySenderFailure: (sender: string, channel: string, reason: string) => Promise<void> =
    async (sender, channel, reason) => {
      const { recordSenderDeliveryFailure } = await import("../chat/delivery-notices.js");
      await recordSenderDeliveryFailure(sender, channel, reason);
    };

  constructor() {
    // Release gated messages when a mind's routes.json changes.
    setRoutesChangeListener((mind) => {
      this.releaseGated(mind).catch((err) =>
        dlog.warn(`failed to release gated messages for ${mind}`, log.errorData(err)),
      );
    });
  }

  /** Test seam: override the mind-running predicate. */
  /**
   * Install the hold check. A single resolver, not a list: a caller that wants to hold for
   * a second reason ORs it into the same function, which keeps the "why is this message
   * waiting" answer in one place instead of spread across independently-registered gates.
   */
  setHoldCheck(fn: (baseName: string, session: string) => DeliveryHold | null): void {
    this.holdCheck = fn;
  }

  setRunningCheck(fn: (baseName: string) => boolean): void {
    this.isMindRunning = fn;
  }

  /** Test seam: capture/override system notifications sent to minds. */
  setNotifier(fn: (mindName: string, text: string) => Promise<void>): void {
    this.notify = fn;
  }

  /** Test seam: capture/override dead-letter failure notices. */
  setFailureNotifier(fn: (input: RecordNoticeInput) => Promise<void>): void {
    this.notifyFailure = fn;
  }

  /** Test seam: capture/override sender-side dead-letter notices. */
  setSenderFailureNotifier(
    fn: (sender: string, channel: string, reason: string) => Promise<void>,
  ): void {
    this.notifySenderFailure = fn;
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
        sessionName = newEphemeralSession();
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
    if (shouldGate(config, route)) {
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
      sessionName = newEphemeralSession();
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

      // Check the hold BEFORE the batch buffer: a held row added to a buffer would flush,
      // be held at the POST, be re-added on the next sweep, and churn a timer every pass
      // for as long as the hold lasts.
      const hold = this.holdCheck(row.mind, row.thread);
      if (hold) {
        await this.markHeld(row.id, payload, hold);
        continue;
      }

      const config = getRoutingConfig(row.mind);
      const sessionConfig = resolveDeliveryMode(config, row.thread);

      // Resolve delivery from the original target (may be a variant) — the `mind`
      // column is the base name, used only for keying/cleanup. Falls back to `mind`
      // for legacy rows with no recorded target.
      const target = row.target_mind ?? row.mind;

      if (sessionConfig.delivery.mode === "batch") {
        this.inFlight.add(row.id);
        this.addToBatchBuffer(target, row.thread, sessionConfig, {
          payload,
          channel: payload.channel,
          sender: payload.sender ?? null,
          createdAt: Date.now(),
          queueId: row.id,
        });
      } else {
        this.deliverToMind(target, row.thread, payload, sessionConfig, row.id).catch((err) => {
          dlog.warn(`failed to redrive delivery for ${target}`, log.errorData(err));
        });
      }
      redriven++;
    }

    if (redriven > 0) dlog.info(`redrove ${redriven} pending delivery queue rows`);
  }

  /**
   * Re-evaluate a mind's `gated` rows against its current routes.json when the routing
   * config changes. For each channel that now matches a `mind` route:
   *  - the newest {@link GATED_RELEASE_LIMIT_PER_CHANNEL} rows are promoted to `pending`
   *    and re-stamped with the freshly-resolved session (NOT the gate-time fallback), so
   *    they land in the correct session instead of `main` (#537 bug 1);
   *  - any older rows are `archived` (inert) so a long backlog can't flood the mind
   *    in one sweep (#537 bug 2), and the mind gets one summary rather than a flood.
   * Rows resolving to a `file` destination are archived (the delivery manager doesn't
   * deliver file routes). Declined channels are skipped entirely — they stay gated.
   *
   * Releases are serialized per mind: the promote step reads gated rows and then writes
   * `mind_history`, and while the promote UPDATE is idempotent the history INSERT is not —
   * two overlapping runs would both see the same rows and record the message twice.
   */
  async releaseGated(mindName: string): Promise<{ released: number; archived: number }> {
    const baseName = await getBaseName(mindName);
    const prev = this.releaseChains.get(baseName) ?? Promise.resolve();
    // `prev` never rejects (both outcomes are swallowed below), so one handler is enough.
    const run = prev.then(() => this.releaseGatedInner(mindName, baseName));
    const chain = run.then(
      () => undefined,
      () => undefined,
    );
    this.releaseChains.set(baseName, chain);
    try {
      return await run;
    } finally {
      // Drop the entry only if nothing queued behind this run, so the map doesn't keep
      // one permanent entry per mind ever released.
      if (this.releaseChains.get(baseName) === chain) this.releaseChains.delete(baseName);
    }
  }

  private async releaseGatedInner(
    mindName: string,
    baseName: string,
  ): Promise<{ released: number; archived: number }> {
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
      return { released: 0, archived: 0 };
    }

    // Group newly-matching mind-route rows by channel, recomputing the session so the
    // release delivers to the CURRENT route. File-route matches are archived. Each row
    // carries the fields needed to record its inbound history at release time — gated
    // messages are NOT recorded on arrival (the mind never saw them, #420), so the real
    // inbound row is written here, when the message is finally delivered.
    type Promotable = {
      id: number;
      session: string;
      channel: string;
      sender: string | null;
      content: string | null;
    };
    const byChannel = new Map<string, Promotable[]>();
    const archiveIds: number[] = [];

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
      if (!route.matched) continue; // still unrouted → leave gated
      if (route.destination === "file") {
        archiveIds.push(row.id); // not deliverable via the delivery manager
        continue;
      }
      let session = route.session;
      if (session === "$new") {
        session = newEphemeralSession();
      }
      const channel = row.channel ?? payload.channel ?? "unknown";
      const list = byChannel.get(channel) ?? [];
      list.push({
        id: row.id,
        session,
        channel,
        sender: payload.sender ?? row.sender ?? null,
        content: extractTextContent(payload.content),
      });
      byChannel.set(channel, list);
    }

    const promote: Promotable[] = [];
    const truncationNotes: string[] = [];
    for (const [channel, items] of byChannel) {
      // A declined channel stays gated even if a rule now matches — the mind opted out.
      if (await this.isChannelDeclined(baseName, channel)) continue;
      // Newest-first so the release keeps the most recent context.
      items.sort((a, b) => b.id - a.id);
      const keep = items.slice(0, GATED_RELEASE_LIMIT_PER_CHANNEL);
      const drop = items.slice(GATED_RELEASE_LIMIT_PER_CHANNEL);
      promote.push(...keep);
      for (const d of drop) archiveIds.push(d.id);
      if (drop.length > 0) {
        truncationNotes.push(
          `${channel}: released the ${keep.length} most recent message(s); ${drop.length} earlier ` +
            `message(s) were held while unrouted and stay readable ` +
            `(volute chat channels peek "${channel}").`,
        );
        dlog.info(
          `truncated gated release for ${baseName} on ${channel}: kept ${keep.length}, archived ${drop.length}`,
        );
      }
    }

    if (archiveIds.length > 0) {
      try {
        const db = await getDb();
        // Chunk the id list so a large sub-7-day backlog can't exceed SQLite's ~999
        // bound-variable limit — this IS the flood-prevention path, so it must not throw.
        for (let i = 0; i < archiveIds.length; i += 500) {
          await db
            .update(deliveryQueue)
            .set({ status: "archived" })
            .where(inArray(deliveryQueue.id, archiveIds.slice(i, i + 500)));
        }
      } catch (err) {
        dlog.warn(`failed to archive gated rows for ${baseName}`, log.errorData(err));
      }
    }

    if (promote.length === 0) {
      if (truncationNotes.length > 0) await this.sendReleaseSummary(mindName, truncationNotes);
      return { released: 0, archived: archiveIds.length };
    }

    // Record inbound history AND promote to pending atomically, oldest-first. Gated
    // messages are never recorded on arrival (#420), so this is the sole "the mind received
    // this" write — and the background redrive sweep reads `pending` rows independently, so
    // the inbound row MUST be committed before the row becomes pending. One transaction per
    // row makes that ordering crash-safe: a failure rolls back both, leaving the row `gated`
    // (retried on the next release) rather than delivered-without-history or duplicated.
    const orderedPromote = [...promote].sort((a, b) => a.id - b.id);
    // Counted per committed transaction, not from promote.length, so a failure partway
    // through reports what actually reached the mind rather than zero.
    let committed = 0;
    try {
      const db = await getDb();
      for (const p of orderedPromote) {
        await db.transaction(async (tx) => {
          await tx.insert(mindHistory).values({
            mind: baseName,
            type: "inbound",
            channel: p.channel,
            sender: p.sender,
            content: p.content,
          });
          await tx
            .update(deliveryQueue)
            .set({ status: "pending", thread: p.session, attempts: 0, next_attempt_at: null })
            .where(eq(deliveryQueue.id, p.id));
        });
        committed++;
      }
      dlog.info(`released ${committed} gated message(s) for ${baseName} after route change`);
    } catch (err) {
      // This is the ONLY recording point for gated traffic — a permanent failure here is a
      // silent history gap, so surface it loudly with enough context to find the messages.
      dlog.error(
        `failed to record+promote gated rows for ${baseName} (channels: ${[...byChannel.keys()].join(", ")})`,
        log.errorData(err),
      );
      return { released: committed, archived: archiveIds.length };
    }

    // Publish the inbound events after commit so live streams reflect the released backlog.
    for (const p of orderedPromote) {
      publishMindEvent(baseName, {
        mind: baseName,
        type: "inbound",
        channel: p.channel,
        content: p.content ?? undefined,
        sender: p.sender ?? undefined,
      });
    }

    if (truncationNotes.length > 0) await this.sendReleaseSummary(mindName, truncationNotes);
    // Deliver immediately rather than waiting for the next sweep.
    await this.redrive();
    return { released: committed, archived: archiveIds.length };
  }

  /**
   * Channels this mind could plausibly mean, from three sources:
   *
   * 1. Its current queue rows — channels with a live `gated`/`archived`/`pending` backlog.
   * 2. Its own history — the durable record. Source 1 alone is not enough: delivered rows
   *    are *deleted* (`deleteQueueRows`), so a channel the mind has been using
   *    successfully for months drops out of the queue entirely, and an external-platform
   *    channel like `discord:general` is in no other table. Without this, the healthier
   *    the channel, the more likely we'd call it unrecognized.
   * 3. Every *public* Volute channel, so a channel can be recognized before its first
   *    message ever arrives.
   *
   * Private channels are deliberately excluded from source 3. This set feeds the "did you
   * mean X?" suggestion, so anything in it can be echoed back to a mind that guessed a
   * nearby name — which would turn a typo into a way to confirm a private channel exists
   * and learn its exact slug. Minds are untrusted principals. A private channel the mind
   * is genuinely in still resolves via sources 1 and 2, which are scoped to it.
   */
  private async knownChannels(baseName: string): Promise<string[]> {
    const db = await getDb();
    const queued = await db
      .selectDistinct({ channel: deliveryQueue.channel })
      .from(deliveryQueue)
      .where(eq(deliveryQueue.mind, baseName));
    const seen = await db
      .selectDistinct({ channel: mindHistory.channel })
      .from(mindHistory)
      .where(eq(mindHistory.mind, baseName));
    const named = await db
      .selectDistinct({ name: channels.name })
      .from(channels)
      .where(eq(channels.private, 0));
    const out = new Set<string>();
    for (const r of queued) if (r.channel) out.add(r.channel);
    for (const r of seen) if (r.channel) out.add(r.channel);
    for (const r of named) out.add(`#${r.name}`);
    return [...out];
  }

  /**
   * Match a channel name the caller supplied against the channels that actually exist.
   *
   * The failure this exists to prevent: a mind is told to run `... accept #garden`, hits
   * the shell's comment character, drops the `#` to "fix" it, and accepts `garden` — a
   * name nothing will ever send from. That wrote a permanent junk rule to routes.json and
   * reported success, leaving the mind believing it had joined a channel it could send to
   * but would never hear from. A one-way channel it had no reason to doubt.
   *
   * A near-miss (same name modulo sigil and case) is reported so callers can refuse with
   * the real slug. A name with no near-miss is *not* an error — pre-routing a channel
   * before its first message arrives is legitimate — but it comes back `known: false` so
   * callers can say plainly that nothing was recognized instead of implying a join.
   */
  private async matchChannelName(
    baseName: string,
    channel: string,
  ): Promise<{ known: boolean; suggestions: string[] }> {
    let all: string[];
    try {
      all = await this.knownChannels(baseName);
    } catch (err) {
      // Never turn a lookup failure into a refusal: that would block a legitimate accept
      // on a DB hiccup. Degrade to today's permissive behaviour.
      dlog.warn(`failed to list known channels for ${baseName}`, log.errorData(err));
      return { known: true, suggestions: [] };
    }
    if (all.includes(channel)) return { known: true, suggestions: [] };
    const key = normalizeChannelKey(channel);
    // Every near-miss, not the best one: a bare `alice` can mean the DM `@alice` or the
    // channel `#alice`, and there is no basis for preferring either. Sorted only so the
    // message is stable between runs.
    const near = all.filter((c) => normalizeChannelKey(c) === key).sort();
    return { known: false, suggestions: near };
  }

  /**
   * Whether the mind has explicitly declined a channel. A declined channel keeps
   * persisting history but never notifies and is never released. #537
   */
  private async isChannelDeclined(baseName: string, channel: string | null): Promise<boolean> {
    if (!channel) return false;
    try {
      const db = await getDb();
      const rows = await db
        .select({ state: channelGates.state })
        .from(channelGates)
        .where(and(eq(channelGates.mind, baseName), eq(channelGates.channel, channel)));
      return rows[0]?.state === "declined";
    } catch (err) {
      dlog.warn(`failed to read gate state for ${baseName}/${channel}`, log.errorData(err));
      return false;
    }
  }

  /**
   * Record that a mind has declined an unrouted channel: future messages are still
   * persisted (history is preserved) but never notify, and any currently-gated rows are
   * archived so they're inert. Returns the number of held messages archived. #537
   */
  async declineChannel(mindName: string, channel: string): Promise<number> {
    const baseName = await getBaseName(mindName);
    // Same near-miss guard as accept: declining "garden" would record a permanent opt-out
    // against a name nothing sends from, while "#garden" kept right on notifying.
    const match = await this.matchChannelName(baseName, channel);
    if (match.suggestions.length > 0) throw new UnknownChannelError(channel, match.suggestions);
    const db = await getDb();
    await db
      .insert(channelGates)
      .values({ mind: baseName, channel, state: "declined" })
      .onConflictDoUpdate({
        target: [channelGates.mind, channelGates.channel],
        set: { state: "declined", updated_at: sql`(datetime('now'))` },
      });
    const archived = await db
      .update(deliveryQueue)
      .set({ status: "archived" })
      .where(
        and(
          eq(deliveryQueue.mind, baseName),
          eq(deliveryQueue.channel, channel),
          eq(deliveryQueue.status, "gated"),
        ),
      )
      .returning({ id: deliveryQueue.id });
    dlog.info(
      `declined channel ${channel} for ${baseName}; archived ${archived.length} held row(s)`,
    );
    return archived.length;
  }

  /**
   * Accept an unrouted (gated) channel: add a routing rule for it to the mind's routes.json
   * and release its held messages immediately.
   *
   * This exists because a hand-edited routes.json is only noticed lazily, when the *next*
   * inbound message triggers a config read — so editing the file on a quiet mind releases
   * nothing and the held messages sit there indefinitely. Accept applies the change and
   * reports what it actually released. #537
   */
  async acceptChannel(
    mindName: string,
    channel: string,
    thread?: string,
  ): Promise<{
    ruleAdded: boolean;
    thread: string;
    released: number;
    archived: number;
    known: boolean;
  }> {
    const baseName = await getBaseName(mindName);
    // Serialize the whole read-modify-write per mind: two concurrent accepts (an agent
    // issuing parallel tool calls, say) would otherwise both read the old config and the
    // second write would drop the first one's rule — silently, after reporting success.
    const prev = this.acceptChains.get(baseName) ?? Promise.resolve();
    const run = prev.then(() => this.acceptChannelInner(mindName, baseName, channel, thread));
    const chain = run.then(
      () => undefined,
      () => undefined,
    );
    this.acceptChains.set(baseName, chain);
    try {
      return await run;
    } finally {
      if (this.acceptChains.get(baseName) === chain) this.acceptChains.delete(baseName);
    }
  }

  private async acceptChannelInner(
    mindName: string,
    baseName: string,
    channel: string,
    thread?: string,
  ): Promise<{
    ruleAdded: boolean;
    thread: string;
    released: number;
    archived: number;
    known: boolean;
  }> {
    // Check the name before touching routes.json: a near-miss must not leave a rule behind.
    const match = await this.matchChannelName(baseName, channel);
    if (match.suggestions.length > 0) throw new UnknownChannelError(channel, match.suggestions);

    const path = routesConfigPath(baseName);

    let config: RoutingConfig;
    try {
      const parsed: unknown = JSON.parse(await readFile(path, "utf-8"));
      // Valid JSON that isn't an object (an array — a shape this codebase has seen on disk
      // — or null, or a string) would let the rule silently
      // vanish at stringify time while we reported success. And an array-form config is
      // exactly a mind with no `rules`, i.e. one gating everything: the case this exists for.
      if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`routes.json for ${baseName} is malformed (not a JSON object)`);
      }
      config = parsed as RoutingConfig;
    } catch (err) {
      // No routes.json yet is fine — accept creates one. Anything else (malformed JSON,
      // unreadable file) must NOT be overwritten: it's a mind-owned file and clobbering it
      // would lose routing the mind wrote by hand.
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
        throw new Error(
          `routes.json for ${baseName} is unreadable or malformed — not modifying it`,
        );
      }
      config = {};
    }

    const rules = Array.isArray(config.rules) ? config.rules : [];
    const targetThread = thread ?? "${channel}";

    // Is the channel already routed? Ask the router rather than pattern-matching the rules
    // ourselves: a broader rule (`discord:*`) covers `discord:general` without being equal
    // to it, and appending a redundant rule *after* it would sit somewhere it can never
    // match — leaving `--thread` silently ineffective and the reported thread a lie.
    const existing = resolveRoute({ ...config, rules }, { channel });
    const ruleAdded = !existing.matched;

    if (ruleAdded) {
      // Append: nothing matches the channel today, so a rule at the end can't be shadowed,
      // and the mind's own rule ordering is preserved.
      rules.push({ channel, thread: targetThread });
      config.rules = rules;
      await mkdir(dirname(path), { recursive: true });
      // Write-then-rename: truncating in place means a crash mid-write leaves an
      // unparseable routes.json, which getRoutingConfig degrades to `{}` — and with
      // gateUnmatched defaulting on, that is a total delivery blackout for the mind.
      const tmp = `${path}.${process.pid}.tmp`;
      await writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`);
      await rename(tmp, path);
    }

    // Clear any decline so re-accepting after a decline actually works.
    const db = await getDb();
    await db
      .delete(channelGates)
      .where(and(eq(channelGates.mind, baseName), eq(channelGates.channel, channel)));

    // Snapshot this channel's held rows so the counts we report describe the channel the
    // caller named. The release itself is mind-wide (accepting one channel must not strand
    // another that a rule already covers), so its totals would over-report here.
    const heldBefore = await db
      .select({ id: deliveryQueue.id })
      .from(deliveryQueue)
      .where(
        and(
          eq(deliveryQueue.mind, baseName),
          eq(deliveryQueue.channel, channel),
          eq(deliveryQueue.status, "gated"),
        ),
      );

    // Suppress the listener-driven release: it runs detached, and racing it against the
    // awaited run below would make the returned counts unreliable.
    clearConfigCache(baseName, { notify: false });
    await this.releaseGated(mindName);

    let released = 0;
    let archived = 0;
    const ids = heldBefore.map((r) => r.id);
    // Chunked to stay under SQLite's ~999 bound-variable limit on a long backlog.
    for (let i = 0; i < ids.length; i += 500) {
      const after = await db
        .select({ status: deliveryQueue.status })
        .from(deliveryQueue)
        .where(inArray(deliveryQueue.id, ids.slice(i, i + 500)));
      for (const row of after) {
        if (row.status === "archived") archived++;
        else if (row.status !== "gated") released++;
      }
    }

    dlog.info(
      `accepted channel ${channel} for ${baseName} (rule ${ruleAdded ? "added" : "already present"}); ` +
        `released ${released}, archived ${archived}`,
    );
    // Report where messages will actually land, resolved through the same router the
    // delivery path uses — so template expansion (`${channel}`) and any pre-existing
    // broader rule are both reflected, rather than echoing back what was asked for.
    const finalRoute = ruleAdded ? resolveRoute({ ...config, rules }, { channel }) : existing;
    return {
      ruleAdded,
      thread: finalRoute.destination === "file" ? finalRoute.path : finalRoute.session,
      released,
      archived,
      known: match.known,
    };
  }

  /**
   * Read the messages held on a channel without changing anything. Archived rows are
   * included: a truncated or declined backlog stays readable, which is what the invite and
   * release-summary texts promise. Gated messages have no conversation, so `volute chat
   * read` can't show them — this is the only way to see them.
   *
   * Returns the most recent {@link PEEK_LIMIT} messages (oldest-first within that window)
   * alongside the true total, so peeking at a spam channel with a huge backlog can't dump
   * all of it into the mind's context — the same reason releases are truncated. #537
   */
  async peekChannel(
    mindName: string,
    channel: string,
  ): Promise<{
    channel: string;
    count: number;
    shown: number;
    suggestions?: string[];
    messages: { sender: string | null; content: string; createdAt: string; status: string }[];
  }> {
    const baseName = await getBaseName(mindName);
    const db = await getDb();
    const rows = await db
      .select()
      .from(deliveryQueue)
      .where(
        and(
          eq(deliveryQueue.mind, baseName),
          eq(deliveryQueue.channel, channel),
          inArray(deliveryQueue.status, ["gated", "archived"]),
        ),
      );

    const messages = rows
      .sort((a, b) => a.id - b.id)
      .slice(-PEEK_LIMIT)
      .map((row) => {
        let content = "";
        try {
          content = extractTextContent((JSON.parse(row.payload) as DeliveryPayload).content);
        } catch {
          content = "(unreadable payload)";
        }
        return {
          sender: row.sender,
          content,
          createdAt: row.created_at,
          status: row.status,
        };
      });

    // "No held messages on garden" is a confident answer to the wrong question when the
    // caller meant "#garden". Peek doesn't refuse — reading is harmless and an empty
    // backlog is a real answer — but it must not let a near-miss read as an all-clear.
    const near =
      rows.length === 0 ? (await this.matchChannelName(baseName, channel)).suggestions : [];

    return {
      channel,
      count: rows.length,
      shown: messages.length,
      suggestions: near.length > 0 ? near : undefined,
      messages,
    };
  }

  /**
   * Re-evaluate every mind's held messages against its current routes.json. Run at daemon
   * startup: routes.json edits made while the daemon was down would otherwise not be noticed
   * until the next inbound message on that channel — which, for a quiet channel, may be never.
   */
  async releaseGatedSweep(): Promise<void> {
    let minds: { mind: string }[];
    try {
      const db = await getDb();
      minds = await db
        .selectDistinct({ mind: deliveryQueue.mind })
        .from(deliveryQueue)
        .where(eq(deliveryQueue.status, "gated"));
    } catch (err) {
      dlog.warn("failed to list minds with gated messages", log.errorData(err));
      return;
    }

    for (const { mind } of minds) {
      try {
        const { released, archived } = await this.releaseGated(mind);
        if (released > 0 || archived > 0) {
          dlog.info(`startup sweep for ${mind}: released ${released}, archived ${archived}`);
        }
      } catch (err) {
        dlog.warn(`startup gated sweep failed for ${mind}`, log.errorData(err));
      }
    }
  }

  /**
   * Send the mind a single summary when a routing change released a truncated backlog,
   * rather than a flood of individual messages. #537
   */
  private async sendReleaseSummary(mindName: string, notes: string[]): Promise<void> {
    const body = [
      `[Channel backlog released]`,
      `A routing change matched channel(s) that had held messages while unrouted. To avoid ` +
        `flooding you, only the ${GATED_RELEASE_LIMIT_PER_CHANNEL} most recent per channel were delivered:`,
      "",
      ...notes.map((n) => `- ${n}`),
    ].join("\n");
    try {
      await this.notify(mindName, body);
    } catch (err) {
      dlog.warn(`failed to send release summary for ${mindName}`, log.errorData(err));
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
   * Resets active counts, clears typing indicators, and cleans up batch buffers
   * so ghost state doesn't accumulate.
   */
  clearMindSessions(mindName: string): void {
    this.sessionStates.delete(mindName);
    // Free the mind's stale-send gate state so it doesn't linger after stop.
    clearMind(mindName);
    // Clear typing indicators for this mind: entries are persistent (no TTL) and after a
    // successful delivery are only cleared on `done`, so a stopped/crashed mind that never
    // emits `done` would leave ghost typing entries. Publish so connected web clients drop
    // the indicator immediately.
    const typingMap = getTypingMap();
    publishTypingForChannels(typingMap.deleteSender(mindName), typingMap);
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

  /**
   * Stamp a row as held, once, so the wait can be shown to the mind when it finally
   * arrives. Persisted into the row's own payload JSON rather than a new column: the
   * payload is already ours, and the marker has to survive a daemon restart because a
   * hold can outlive one (a daily cap holds for up to a day).
   *
   * Mutates `payload` as well as the row so the in-memory copy a batch buffer is holding
   * matches what is on disk. A row already marked is left alone — the *first* time it was
   * held is the honest answer to "how long did this wait", and the redrive sweep re-offers
   * a held row every pass.
   */
  private async markHeld(
    queueId: number,
    payload: DeliveryPayload,
    hold: DeliveryHold,
  ): Promise<void> {
    if (payload.held) return;
    payload.held = { at: Date.now(), scope: hold.scope };
    try {
      const db = await getDb();
      await db
        .update(deliveryQueue)
        .set({ payload: JSON.stringify(payload) })
        .where(eq(deliveryQueue.id, queueId));
    } catch (err) {
      // Non-fatal: the row is still held and still pending. Only the "this waited"
      // preface is lost, and only if the daemon restarts before the next attempt.
      dlog.warn(`failed to mark delivery ${queueId} held`, log.errorData(err));
    }
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

  /**
   * Record the outcome of a failed delivery attempt: set a backoff window so the target
   * isn't hot-looped, and — for a LIVE rejection — advance the dead-letter counter.
   *
   * Only a live rejection (`liveRejection: true`: the target was reachable and answered with
   * a non-OK HTTP status) counts toward {@link MAX_DELIVERY_ATTEMPTS}. A transport failure
   * (`liveRejection: false`: connection refused, reset, or timeout — the mind or a detached
   * variant is simply down/unreachable) backs off WITHOUT advancing the counter, so a merely
   * offline target is never dead-lettered and its message is preserved until it returns. The
   * redrive guard only checks the base mind's up-ness, so a stopped variant reaches here on
   * every sweep — this is what stops that from silently dropping its messages. #356
   *
   * A row that reaches the ceiling moves to the terminal `dead` status (excluded from
   * redrive, which only reads `pending`) and the batch is surfaced as one failure notice.
   *
   * Rows here are still `inFlight` (the caller clears ownership in its own `finally`, after
   * this resolves), so the concurrent redrive sweep skips them and can't race this update.
   */
  private async scheduleRetry(
    ids: (number | undefined)[],
    opts: { liveRejection: boolean },
  ): Promise<void> {
    const valid = [...new Set(ids.filter((id): id is number => typeof id === "number"))];
    if (valid.length === 0) return;
    try {
      const db = await getDb();
      const rows = await db
        .select({
          id: deliveryQueue.id,
          attempts: deliveryQueue.attempts,
          mind: deliveryQueue.mind,
          target_mind: deliveryQueue.target_mind,
          thread: deliveryQueue.thread,
          channel: deliveryQueue.channel,
          sender: deliveryQueue.sender,
          created_at: deliveryQueue.created_at,
        })
        .from(deliveryQueue)
        .where(inArray(deliveryQueue.id, valid));
      const dead: DeadLetterRow[] = [];
      for (const row of rows) {
        // Transport failure: back off on the current (unadvanced) counter, don't dead-letter.
        if (!opts.liveRejection) {
          await db
            .update(deliveryQueue)
            .set({ next_attempt_at: this.backoffExpr(row.attempts) })
            .where(eq(deliveryQueue.id, row.id));
          continue;
        }
        const attempts = row.attempts + 1;
        if (attempts >= MAX_DELIVERY_ATTEMPTS) {
          // Log BEFORE the terminal UPDATE so a crash between the two can't drop a message
          // without a trace. #356
          dlog.error(
            `dead-lettering delivery queue row ${row.id} for ${row.mind} after ${attempts} ` +
              `live rejections (channel=${row.channel ?? "?"}, sender=${row.sender ?? "?"})`,
          );
          // Gate the transition on the row still being `pending` and only notify on a row that
          // actually flipped — so a (currently unreachable) re-process of an already-`dead` row
          // can't fire a duplicate notice. Makes the terminal-once invariant provable, not assumed.
          const flipped = await db
            .update(deliveryQueue)
            .set({ attempts, status: "dead", next_attempt_at: null })
            .where(and(eq(deliveryQueue.id, row.id), eq(deliveryQueue.status, "pending")))
            .returning({ id: deliveryQueue.id });
          if (flipped.length > 0) dead.push(row);
          continue;
        }
        await db
          .update(deliveryQueue)
          .set({ attempts, next_attempt_at: this.backoffExpr(attempts) })
          .where(eq(deliveryQueue.id, row.id));
      }
      if (dead.length > 0) await this.notifyDeadLettered(dead);
    } catch (err) {
      // This path now guards the dead-letter transition, so a failure here can strand a row
      // one attempt short of terminal — surface it loudly, not at warn.
      dlog.error("failed to record delivery retry / dead-letter", log.errorData(err));
    }
  }

  /** Exponential backoff window (capped at {@link RETRY_MAX_MS}) as a SQL datetime expr. */
  private backoffExpr(attempts: number) {
    const backoffSec = Math.round(
      Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(attempts, 20)) / 1000,
    );
    return sql`datetime('now', ${`+${backoffSec} seconds`})`;
  }

  /**
   * Surface a batch of dead-lettered rows as ONE next-turn failure notice, so a whole failing
   * batch can't emit dozens of notices and evict unrelated ones via the per-thread overflow
   * cap. The notice names the channel(s) and send times and points the mind at the surviving
   * channel history, and never throws back into the delivery path — the rows are terminal. #356
   */
  private async notifyDeadLettered(rows: DeadLetterRow[]): Promise<void> {
    const mind = rows[0].mind;
    // Rows in one scheduleRetry call share a (mind, thread) batch. If that thread is an
    // ephemeral `$new` session, its only message WAS the dropped one — no turn will ever run
    // to drain a notice parked there — so route the notice to MIND_LEVEL_THREAD instead. #356
    const threads = new Set(rows.map((r) => r.thread));
    const single = threads.size === 1 ? [...threads][0] : MIND_LEVEL_THREAD;
    const thread = single.startsWith("new-") ? MIND_LEVEL_THREAD : single;

    const lines = rows.map((r) => {
      const from = r.sender ? ` from ${r.sender}` : "";
      const on = r.channel ? ` on ${r.channel}` : "";
      // The notice is delivered to the base mind, but the rejecting process may be a variant —
      // name it so the mind isn't told "your process is rejecting" about a process it isn't. #356
      const to =
        r.target_mind && r.target_mind !== r.mind ? ` to your variant ${r.target_mind}` : "";
      return `- a message${from}${on}${to} (sent ${r.created_at})`;
    });
    const channels = [...new Set(rows.map((r) => r.channel).filter((c): c is string => !!c))];
    const recovery =
      channels.length > 0
        ? `The original message(s) remain in the channel history — read them with ` +
          `${channels.map((c) => `\`volute chat read ${c}\``).join(" or ")}.`
        : `The original message(s) remain in the channel history.`;
    const detail = [
      `${rows.length} message(s) sent to you could not be delivered after ` +
        `${MAX_DELIVERY_ATTEMPTS} attempts and were dropped:`,
      ...lines,
      recovery,
    ].join("\n");
    try {
      await this.notifyFailure({
        mind,
        thread,
        kind: "delivery_failed",
        reason: "delivery_failed",
        detail,
      });
    } catch (err) {
      dlog.warn(`failed to send dead-letter notice for ${mind}`, log.errorData(err));
    }

    // The sender said something and nobody heard — if the sender is a mind, tell it
    // too (#366). One call per distinct (sender, channel); the sender-side helper
    // no-ops for humans and coalesces bursts, so a failing batch stays one notice.
    // From the sender's perspective a DM channel is named after the *recipient*, not
    // the "@sender" slug the recipient's queue row carries. Queue rows store DM slugs
    // through buildVoluteSlug — `@${slugify(sender)}`, not the raw sender name.
    const senderPairs = new Map<string, { sender: string; channel: string }>();
    for (const r of rows) {
      if (!r.sender || r.sender === r.mind) continue;
      const recipient = r.target_mind ?? r.mind;
      const channel =
        !r.channel || r.channel === `@${slugify(r.sender)}` ? `@${recipient}` : r.channel;
      senderPairs.set(`${r.sender}\n${channel}`, { sender: r.sender, channel });
    }
    for (const { sender, channel } of senderPairs.values()) {
      try {
        await this.notifySenderFailure(
          sender,
          channel,
          `the recipient's process rejected it after ${MAX_DELIVERY_ATTEMPTS} attempts`,
        );
      } catch (err) {
        dlog.warn(`failed to send sender dead-letter notice for ${sender}`, log.errorData(err));
      }
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

      // Held? Leave the row `pending` and touch nothing else — before the active count,
      // before the stale-send baseline, before typing indicators. A mind that never saw
      // this message must not be recorded as having seen it, must not appear to be
      // typing about it, and must not have a reply of its own gated against it.
      //
      // Only a message the queue is actually holding can be held: with no row (the insert
      // failed), there is nothing to redeliver from, so holding it would silently destroy
      // what someone said. A cap is worth leaking before a message is worth losing.
      const hold = this.holdCheck(baseName, session);
      if (hold && queueId != null) {
        dlog.debug(`holding delivery to ${baseName}/${session} (${hold.reason})`);
        await this.markHeld(queueId, payload, hold);
        this.inFlight.delete(queueId);
        return;
      }
      if (hold) {
        dlog.warn(
          `delivering to ${baseName}/${session} despite a ${hold.reason} hold: the message ` +
            `has no delivery_queue row, so holding it would drop it`,
        );
      }

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

      // Set typing indicator on both slug and conversationId keys, and publish the
      // conversationId key so the web UI learns the mind is typing at delivery time
      // (not incidentally via an unrelated re-publish).
      const typingMap = getTypingMap();
      if (payload.channel) {
        typingMap.set(payload.channel, baseName, { persistent: true });
      }
      if (payload.conversationId) {
        typingMap.set(payload.conversationId, baseName, { persistent: true });
        publishTypingForChannels([payload.conversationId], typingMap);
      }

      // Mark mind as active immediately at delivery time (before it emits events)
      onMindEvent(baseName, "delivery", payload.channel);

      // Enrich with participant profiles on first encounter per channel
      const enrichedPayload = withHeldPreface(
        await this.enrichWithProfiles(baseName, session, payload),
      );

      const body = JSON.stringify({
        ...enrichedPayload,
        session,
        instructions: sessionConfig.instructions,
        interrupt: sessionConfig.interrupt,
      });

      try {
        const ok = await this.postToMind(port, body);
        if (!ok) {
          // Reachable but rejected (non-OK HTTP) → a live rejection that counts toward the ceiling.
          this.decrementActive(baseName, session);
          publishTypingForChannels(typingMap.deleteSender(baseName), typingMap);
          await this.scheduleRetry([queueId], { liveRejection: true });
        } else {
          // Mark delivered ONLY on ack, by specific row id — never a broad DELETE.
          await this.deleteQueueRows([queueId]);
        }
      } catch (err) {
        // Threw → transport failure (mind/variant down or timed out), NOT a live rejection.
        dlog.warn(`failed to deliver to ${mindName}`, log.errorData(err));
        this.decrementActive(baseName, session);
        publishTypingForChannels(typingMap.deleteSender(baseName), typingMap);
        await this.scheduleRetry([queueId], { liveRejection: false });
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

      // Held? Same as the immediate path: the whole batch stays `pending` and untouched.
      // A batch is delivered as one envelope, so it is held only when every message in it
      // has a row to be held in — otherwise the unpersisted ones would have nothing to come
      // back from, and a hold would quietly become a deletion.
      const hold = this.holdCheck(baseName, session);
      if (hold && queueIds.length === messages.length) {
        dlog.debug(
          `holding batch of ${messages.length} to ${baseName}/${session} (${hold.reason})`,
        );
        for (const msg of messages) await this.markHeld(msg.queueId!, msg.payload, hold);
        for (const id of queueIds) this.inFlight.delete(id);
        return;
      }
      if (hold) {
        dlog.warn(
          `delivering a batch to ${baseName}/${session} despite a ${hold.reason} hold: ` +
            `${messages.length - queueIds.length} message(s) have no delivery_queue row, ` +
            `so holding the batch would drop them`,
        );
      }

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
      ).then((msgs) => msgs.map((m) => ({ ...m, payload: withHeldPreface(m.payload) })));

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
      // Also set on conversationId keys for web UI typing, then publish them once so the
      // web UI learns the mind is typing at delivery time.
      const seenConvIds = new Set<string>();
      for (const msg of messages) {
        if (msg.payload.conversationId && !seenConvIds.has(msg.payload.conversationId)) {
          seenConvIds.add(msg.payload.conversationId);
          typingMap.set(msg.payload.conversationId, baseName, { persistent: true });
        }
      }
      if (seenConvIds.size > 0) {
        publishTypingForChannels([...seenConvIds], typingMap);
      }

      const body = JSON.stringify({
        session,
        batch: { channels },
        instructions: sessionConfig.instructions,
        interrupt: sessionConfig.interrupt,
      });

      try {
        const ok = await this.postToMind(port, body);
        if (!ok) {
          // Reachable but rejected (non-OK HTTP) → a live rejection that counts toward the ceiling.
          this.decrementActive(baseName, session);
          publishTypingForChannels(typingMap.deleteSender(baseName), typingMap);
          await this.scheduleRetry(queueIds, { liveRejection: true });
        } else {
          // Mark delivered ONLY on ack, and ONLY the specific rows in this batch —
          // a broad (mind, session, pending) DELETE would race with rows enqueued
          // concurrently during the flush.
          await this.deleteQueueRows(queueIds);
        }
      } catch (err) {
        // Threw → transport failure (mind/variant down or timed out), NOT a live rejection.
        dlog.warn(`failed to deliver batch to ${mindName}`, log.errorData(err));
        this.decrementActive(baseName, session);
        publishTypingForChannels(typingMap.deleteSender(baseName), typingMap);
        await this.scheduleRetry(queueIds, { liveRejection: false });
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
    // A declined channel's messages are archived immediately (inert): history is still
    // preserved, but they never notify, never surface in getPending/status, and never
    // accumulate as live gated rows — matching declineChannel's own archiving. #537
    const declined = await this.isChannelDeclined(baseName, payload.channel);
    await this.persistToQueue(mindName, session, payload, declined ? "archived" : "gated");
    if (declined) return;

    // Re-notify on a cadence, not just once, so a long silence stays visible. Count over
    // both gated AND archived rows so clearing/truncating the backlog doesn't silently
    // re-arm the invite, and the cadence reflects total messages seen on the channel. #537
    try {
      const db = await getDb();
      const rows = await db
        .select({ count: sql<number>`count(*)` })
        .from(deliveryQueue)
        .where(
          and(
            eq(deliveryQueue.mind, baseName),
            eq(deliveryQueue.channel, payload.channel),
            inArray(deliveryQueue.status, ["gated", "archived"]),
          ),
        );
      const count = rows[0]?.count ?? 0;
      if (count === 1 || count % GATED_NOTIFY_EVERY === 0) {
        await this.sendInviteNotification(mindName, payload, count);
      }
    } catch (err) {
      dlog.warn(`failed to check gated count for ${baseName}`, log.errorData(err));
    }
  }

  private async sendInviteNotification(
    mindName: string,
    payload: DeliveryPayload,
    gatedCount = 1,
  ): Promise<void> {
    const text = extractTextContent(payload.content);
    const preview = text.length > 200 ? `${text.slice(0, 200)}...` : text;
    const channel = payload.channel ?? "unknown";

    const heldLine =
      gatedCount > 1
        ? `${gatedCount} messages from this channel are being held, unrouted — you've not routed it yet.`
        : `Someone new is reaching out — you don't have a route for this channel yet.`;

    // Optional platform/participant lines, each with a trailing newline so the template's
    // fixed line before "Preview:" reads correctly whether or not they're present.
    const detailLines = [
      payload.platform ? `Platform: ${payload.platform}` : null,
      payload.participantCount ? `Participants: ${payload.participantCount}` : null,
    ].filter((l): l is string => l !== null);
    const details = detailLines.length > 0 ? `${detailLines.join("\n")}\n\n` : "\n";

    const { getPrompt } = await import("../prompts.js");
    const notification = await getPrompt("channel_invite", {
      channel,
      heldLine,
      sender: payload.sender ?? "unknown",
      details,
      preview,
      limit: String(GATED_RELEASE_LIMIT_PER_CHANNEL),
    });

    await this.notify(mindName, notification);
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
    status: "pending" | "gated" | "archived" = "pending",
  ): Promise<number | undefined> {
    try {
      const baseName = await getBaseName(mindName);
      const db = await getDb();
      const result = await db
        .insert(deliveryQueue)
        .values({
          mind: baseName,
          target_mind: mindName,
          thread: session,
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
    const profilesSeen = state.seenChannelProfiles.has(channelKey);

    // The channel introduces itself: what it's for, its rules, and the limits it enforces.
    // Without this a mind meets a limit only by being rejected by it, and never learns the
    // rules at all. Re-announced whenever the settings change — a limit added an hour into a
    // long session is exactly the case the card exists for — so this is keyed on the row's
    // updated_at rather than riding the once-per-session profiles gate. A failed read records
    // nothing, so it is retried on the next delivery instead of being lost for the session.
    const ctx = await this.loadChannelContext(payload);
    const freshChannelInfo =
      ctx && state.announcedChannelInfo.get(channelKey) !== ctx.updatedAt ? ctx : null;

    if (profilesSeen && !freshChannelInfo) return payload;

    try {
      const enriched: DeliveryPayload = { ...payload };

      if (freshChannelInfo) {
        enriched.channelInfo = freshChannelInfo.info;
        state.announcedChannelInfo.set(channelKey, freshChannelInfo.updatedAt);
      }

      if (!profilesSeen) {
        const participants = await getParticipants(payload.conversationId);
        enriched.participantProfiles = participants.map((p) => ({
          username: p.username,
          userType: p.userType,
          displayName: p.displayName,
          description: p.description,
        })) satisfies ParticipantProfile[];

        // Read avatar images and prepend as image blocks
        const avatarBlocks = await this.loadAvatarBlocks(participants);

        state.seenChannelProfiles.add(channelKey);
        if (avatarBlocks.length > 0) {
          const existing = Array.isArray(payload.content)
            ? payload.content
            : typeof payload.content === "string"
              ? [{ type: "text" as const, text: payload.content }]
              : [];
          enriched.content = [...avatarBlocks, ...existing];
        }
      }

      return enriched;
    } catch (err) {
      dlog.warn(`failed to fetch participant profiles for ${mindName}`, log.errorData(err));
      return payload;
    }
  }

  /**
   * A channel's self-description: what the channel is for, its rules, and the limits its
   * sends are held to, paired with the row's `updated_at` so the caller can tell a changed
   * card from one already announced. Returns null for DMs, for channels that have set none of
   * these, and on any read failure — this is context, not policy, so it never blocks a
   * delivery.
   */
  private async loadChannelContext(
    payload: DeliveryPayload,
  ): Promise<{ info: ChannelContext; updatedAt: string } | null> {
    if (!payload.conversationId) return null;
    try {
      const channelName = await getChannelName(payload.conversationId);
      if (!channelName) return null;
      const row = await getChannelSettings(channelName);
      if (!row) return null;
      const info: ChannelContext = {
        description: row.description,
        rules: row.rules,
        charLimit: row.char_limit,
        rateLimit: row.rate_limit,
        rateWindow: row.rate_window,
      };
      const hasAnything = Object.values(info).some((v) => v != null);
      return hasAnything ? { info, updatedAt: row.updated_at } : null;
    } catch (err) {
      dlog.warn("failed to load channel context, sending without it", log.errorData(err));
      return null;
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

    for (const p of participants) {
      if (!p.avatar) continue;

      try {
        let filePath: string;
        if (isMind(p)) {
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

        const rendered = await renderAvatarBlock(filePath, p.username);
        if (rendered) blocks.push(...rendered);
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
      announcedChannelInfo: new Map<string, string>(),
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
