import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isMind } from "@volute/api/user-type";
import { and, eq, inArray, sql } from "drizzle-orm";
import { MIND_LEVEL_THREAD, type RecordNoticeInput } from "../chat/system-events.js";
import { getTypingMap, publishTypingForChannels } from "../chat/typing.js";
import { ManagerNotReadyError } from "../daemon/manager-not-ready.js";
import { tryGetMindManager } from "../daemon/mind-manager.js";
import {
  acquireTurnSlot,
  hasTurnSlot,
  releaseTurnSlot,
  turnSlotHolders,
} from "../daemon/turn-slots.js";
import {
  activeOwners,
  adoptInterrupted,
  closedTurnFor,
  getActiveTurnId,
  hasActiveTurn,
  isConnectionRefused,
  linkRowsToTurn,
  markInterrupted,
  type OrphanedTurn,
  openDeliveredTurn,
  unlinkRefused,
  unmarkInterrupted,
} from "../daemon/turn-tracker.js";
import { getDb } from "../db.js";
import { getChannelName, getChannelSettings, getParticipants } from "../events/conversations.js";
import { onMindEvent } from "../events/mind-activity-tracker.js";
import { publish as publishMindEvent } from "../events/mind-events.js";
import { mindFileOwner } from "../mind/isolation.js";
import { replaceMindFile } from "../mind/mind-file-write.js";
import { findMind, getBaseName, voluteHome } from "../mind/registry.js";
import { channelGates, channels, deliveryQueue, mindHistory } from "../schema.js";
import { type AvatarBlock, readMindAvatar, renderAvatarBlock } from "../util/avatar-image.js";
import log from "../util/logger.js";
import { newEphemeralSession } from "../util/session-name.js";
import { slugify } from "../util/slugify.js";
import { parseDbTimestamp, toDbTimestamp } from "../util/time.js";
import {
  type ChannelContext,
  clearConfigCache,
  type DeliveryPayload,
  extractTextContent,
  getRoutingConfig,
  matchMetaFor,
  type ParticipantProfile,
  parseDeliveryPayload,
  type RateLimit,
  type ResolvedDeliveryMode,
  type ResolvedRoute,
  type ResolvedSessionConfig,
  ROUTES_JSON,
  type RoutingConfig,
  resolveDeliveryMode,
  resolveRoute,
  routesMindDir,
  routingDefers,
  setRoutesChangeListener,
  shouldGate,
  toWirePayload,
  type WirePayload,
} from "./delivery-router.js";
import { clearMind, onDeliveredToMind, resetTurn } from "./send-gate.js";
import { sinceNoteFor, withSinceNote } from "./since-last-here.js";

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
// When a spend hold lifts, deliver at most this many of the newest held messages per
// channel; the rest are archived (inert) and named in one summary. Same number and same
// reason as the gated limit above: a day of held traffic released as one message per turn
// would spend the new period's budget in minutes and re-trip the cap, leaving the mind
// alternating between deaf and drowning without ever getting through the backlog.
const HELD_RELEASE_LIMIT_PER_CHANNEL = 10;

// Most-recent messages returned by a peek. Peeking is how a mind decides whether to accept
// a channel; dumping an unbounded backlog into its context to answer that would defeat the
// point of gating in the first place. The true total is reported alongside.
const PEEK_LIMIT = 50;

type AvatarCacheEntry = { blocks: AvatarBlock[]; expiresAt: number };
const avatarBlocksCache = new Map<string, AvatarCacheEntry>();
const AVATAR_CACHE_TTL = 5 * 60 * 1000;

// --- Session state tracking ---

/** A delivery the mind has taken but no `done` has covered yet. */
/** The turn a delivery was put into before its POST (see `enterTurn`). */
export type EnteredTurn = {
  turnId: string;
  created: boolean;
  folded: boolean;
  /** It marked the turn it folded into as interrupted (see `enterTurn`). */
  interrupted?: boolean;
};

type Outstanding = {
  /** The process it was POSTed to — the mind, or one of its variants (see `coveredBy`). */
  process: string;
  /** Its `mind_history` rows, in envelope order — for the turn it turns out to run in. */
  rows: (number | undefined)[];
  /** The running turn it folded into, which its rows were linked to on the ack. */
  foldedInto?: string;
  /** A `done` has covered it; `sessionDone` has yet to retire it (see `markRetiring`). */
  retiring?: boolean;
};

/** What a mind's `done` says about the deliveries it finished (see `coveredBy`). */
export type DoneReport = {
  /** The process that sent the `done`. */
  process: string;
  /** The delivery whose turn it ends. */
  messageId?: string;
  /**
   * The deliveries the `done` finished. Absent on a `done` from a mind whose template
   * predates the field, which is read as covering everything that process had outstanding.
   */
  covers?: string[];
  /** Whether it ends a turn; one that only retires a failed delivery does not. */
  endsTurn: boolean;
};

type SessionState = {
  /** Delivery id → the delivery, for every delivery the mind has taken and not finished. */
  outstanding: Map<string, Outstanding>;
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
  /**
   * A deferred message riding along with this delivery (see `takeDeferred`). It didn't
   * cause the delivery, so a failed POST leaves it `deferred` rather than retrying it.
   */
  rider?: boolean;
  /** Prior failed delivery attempts on the row; a batch holding a retry carries no riders. */
  attempts?: number;
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
export type DeliveryHold = {
  reason: string;
  scope: "mind" | "system";
  /**
   * Epoch millis when this hold is expected to lift, when the reason knows. Recorded on
   * the row so a host (and later the mind) can be told when the wait ends rather than
   * being left to guess.
   */
  until?: number;
  /**
   * This hold lifts on its own within seconds — #823's concurrency gate, which waits out
   * a turn already running rather than a spend period. Momentary holds leave the row
   * `pending` for the next sweep instead of moving it to `held`, and every consumer that
   * treats a hold as a durable park must skip them: `releaseHeld` (a concurrency hold is
   * gone before a release could run, and its rows were never given the `held` status a
   * release looks for), `willHoldMessage` (a mind mid-turn still receives what arrives, so
   * its history row is written at arrival as usual), the wake flush's hand-off to the
   * delivery hold, and the spend branch of `deliverEvent` — a busy mind's schedule stamped
   * `spendHeld` would wait for a spend reset that may never come.
   */
  momentary?: boolean;
};

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
 * Render the daemon's notes about a message — that it was held, deferred, or already
 * peeked at — into its content, and strip their fields (with `inboundDeferred`), so none
 * reaches the mind as a raw field. This is the single strip point for every daemon-only
 * preface field on the way to the wire.
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
export function withHeldPreface(payload: DeliveryPayload): WirePayload {
  return withPeekedPreface(withDeferredPreface(withHeldMarker(payload)));
}

/**
 * Tell the thread a message lands in that the mind was already shown it — by `peek` on a
 * gated channel, or `chat read` while it waited — the latest peek's thread and time, so it
 * isn't met as new and answered twice (#1172). Informational only: nothing is held back.
 */
/**
 * Open the content with participants' avatars. Applied after every preface and the since
 * note, so the avatars sit directly under the mind-side header (which the router puts on the
 * first text block, beside the Participants list they illustrate) rather than after a wall
 * of other-thread activity that makes them read as something the sender attached.
 */
export function withAvatars<T extends { content?: unknown }>(
  payload: T,
  avatars: AvatarBlock[],
): T {
  if (avatars.length === 0) return payload;
  const content = payload.content;
  const existing = Array.isArray(content)
    ? content
    : typeof content === "string"
      ? [{ type: "text" as const, text: content }]
      : content == null
        ? []
        : [content];
  return { ...payload, content: [...avatars, ...existing] };
}

function withPeekedPreface(wire: WirePayload): WirePayload {
  const { peeked, ...rest } = wire;
  if (!peeked) return wire;
  const line =
    `[peeked — you peeked this from thread ${JSON.stringify(peeked.thread)} at ` +
    `${compactLocal(peeked.at)}.]`;
  return prependLine(rest, line);
}

/**
 * Tell the mind a deferred message waited: its routes.json kept it back instead of waking
 * the mind, and it is arriving now with a later turn. Without this it would read as just
 * sent, since the mind stamps each message with the time it formats it.
 */
function withDeferredPreface(wire: WirePayload): WirePayload {
  const { deferred, ...rest } = wire;
  if (!deferred) return wire;
  const line =
    `[deferred — this arrived at ${compactLocal(deferred.at)}; your routes.json kept it ` +
    `for your next turn on this thread instead of waking you.]`;
  return prependLine(rest, line);
}

function withHeldMarker(payload: DeliveryPayload): WirePayload {
  // senderId never crosses to the mind process — see WirePayload (#1017).
  const wire = toWirePayload(payload);
  const held = wire.held;
  if (!held) {
    // Never POST the bookkeeping flag even when nothing was held — `inboundDeferred` is a
    // note to ourselves about `mind_history`, and means nothing to a mind.
    if (wire.inboundDeferred === undefined) return wire;
    const { inboundDeferred: _skip, ...bare } = wire;
    return bare;
  }
  const { held: _marker, inboundDeferred: _deferred, ...rest } = wire;
  const whose = held.scope === "system" ? "this install's spend cap" : "your spend cap";
  const line =
    `[held — this arrived at ${compactLocal(held.at)}, when ${whose} was reached, ` +
    `and waited rather than reaching you then. It is reaching you now.]`;
  return prependLine(rest, line);
}

/**
 * Put a daemon-authored line ahead of a message's content, whatever its shape. Some other
 * shape entirely is wrapped in blocks: that still delivers it and still carries the line,
 * where returning it bare would hand the mind a message that looks brand new — the one
 * outcome these prefaces exist to prevent.
 */
function prependLine(wire: WirePayload, line: string): WirePayload {
  if (typeof wire.content === "string") return { ...wire, content: `${line}\n${wire.content}` };
  if (Array.isArray(wire.content)) {
    return { ...wire, content: [{ type: "text", text: line }, ...wire.content] };
  }
  return { ...wire, content: [{ type: "text", text: line }, wire.content] };
}

/**
 * A queue row's payload as the delivery path sends it: the stored payload, plus the
 * latest peek from the row's own columns (#1172). Every reader that turns a queued row
 * into a delivery goes through this (redrive, and the deferred riders), and every write
 * of a payload back to a row drops it again (`storedPayload`), so the columns are its one
 * source. A peek stamped after the release still reaches the wire — unless a delivery had
 * already read the row. Throws like `parseDeliveryPayload`.
 */
export function queuedPayload(row: typeof deliveryQueue.$inferSelect): DeliveryPayload {
  const payload = parseDeliveryPayload(row.payload);
  if (row.peeked_at && row.peeked_thread) {
    payload.peeked = {
      thread: row.peeked_thread,
      at: parseDbTimestamp(row.peeked_at).getTime(),
    };
  }
  return payload;
}

/** Whether message content is all text — everything a peek can show of it. */
function isTextOnly(content: unknown): boolean {
  return (
    typeof content === "string" ||
    (Array.isArray(content) && content.every((p) => (p as { type?: string }).type === "text"))
  );
}

/**
 * A payload as stored in a queue row. `peeked` is dropped: its source is the row's own
 * columns, attached on read by `queuedPayload`, and a copy persisted by a hold or deferral
 * would be a second source of truth (#1172).
 */
function storedPayload(payload: DeliveryPayload): string {
  const { peeked: _peeked, ...stored } = payload;
  return JSON.stringify(stored);
}

/**
 * Write the `mind_history` inbound row for a message whose arrival-time recording was
 * skipped because the mind was over its spend cap.
 *
 * Stamped with when the message ARRIVED, not when the mind was finally free to hear it:
 * history should say when someone spoke. (The same call as `held.at` — and the reason the
 * row waits until delivery is that a held message may never arrive at all. The oldest of a
 * large backlog are archived at release, and a row recorded on arrival would leave history
 * claiming the mind heard something it never will — #420 by a different road.)
 *
 * Never throws into the delivery path: the message has already been received, and a
 * missing history row is a smaller wrong than a delivery that reports failure and is
 * re-sent. Returns the row's id, or undefined if it could not be written.
 */
export async function recordDeferredInbound(
  baseName: string,
  payload: DeliveryPayload,
  /** The turn it was delivered into, already open on a live timeline (see `enterTurn`). */
  turnId?: string,
): Promise<number | undefined> {
  const arrived = payload.held?.at ?? payload.deferred?.at;
  let id: number | undefined;
  try {
    const db = await getDb();
    const [row] = await db
      .insert(mindHistory)
      .values({
        mind: baseName,
        type: "inbound",
        channel: payload.channel,
        sender: payload.sender ?? null,
        sender_id: payload.senderId,
        content: extractTextContent(payload.content),
        ...(arrived != null ? { created_at: toDbTimestamp(arrived) } : {}),
      })
      .returning({ id: mindHistory.id });
    id = row?.id;
  } catch (err) {
    dlog.warn(`failed to record deferred inbound for ${baseName}`, log.errorData(err));
    return undefined;
  }
  publishMindEvent(baseName, {
    mind: baseName,
    type: "inbound",
    channel: payload.channel,
    content: extractTextContent(payload.content),
    sender: payload.sender ?? undefined,
    turnId,
  });
  return id;
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
   * Per-`baseName:session` start times of the turns delivered on threads with a
   * `rateLimit`, pruned to the window. In memory: a daemon restart forgets the window, which
   * errs toward waking the mind, never toward losing a message.
   */
  private recentWakes = new Map<string, number[]>();

  /**
   * delivery_queue row ids currently owned in-memory — either buffered in a batch
   * buffer or actively being POSTed. The redrive sweep skips these so it never
   * double-delivers a row that the normal path is already handling.
   */
  private inFlight = new Set<number>();

  /**
   * delivery_queue row id → when the concurrency gate first held it and which of the mind's
   * threads it was waiting behind, so the turn it finally starts can say so (#939). In
   * memory: a restart forgets a wait, which costs the line, not the message. Cleared when
   * the row is delivered.
   */
  private waitingSince = new Map<number, { since: number; behind: string[] }>();

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
  /** In-flight sweep, so overlapping `redrive()` calls join it instead of racing it. */
  private redriving: Promise<void> | null = null;
  /** One queued trailing sweep for callers that arrived during an in-flight one. */
  private redriveAgain: Promise<void> | null = null;

  /**
   * Whether a delivery to this (mind, session) must wait. Injected rather than imported so
   * `delivery/` stays free of a dependency on the spend budget (and, later, on whatever
   * else wants to hold — #823's concurrency gate is the next one).
   */
  private holdCheck: (baseName: string, session: string) => DeliveryHold | null = () => null;

  /** Predicate for whether a mind is up; overridable in tests. */
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

  /**
   * Install the hold check. A single resolver, not a list: a caller that wants to hold for
   * a second reason ORs it into the same function, which keeps the "why is this message
   * waiting" answer in one place instead of spread across independently-registered gates.
   */
  setHoldCheck(fn: (baseName: string, session: string) => DeliveryHold | null): void {
    this.holdCheck = fn;
  }

  /**
   * Whether this (mind, session) is currently held, for a delivery path that does not run
   * through this class — see `SleepManager.flushQueuedMessages`, which POSTs a woken mind's
   * backlog directly. One hold answer, however many doors lead to the mind.
   */
  holdReason(baseName: string, session: string): DeliveryHold | null {
    return this.holdCheck(baseName, session);
  }

  /** Test seam: override the mind-running predicate. */
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
        mode: "immediate" | "batch" | "gated" | "deferred";
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
        return { routed: true, session: sessionName, mode: "batch" };
      }
      const queueId = await this.persistToQueue(mindName, sessionName, payload);
      await this.deliverToMind(mindName, sessionName, payload, sessionConfig, queueId);
      return { routed: true, session: sessionName, mode: "immediate" };
    }

    const meta = await matchMetaFor(baseName, config, payload);
    const route = resolveRoute(config, meta);

    dlog.debug(`route for ${mindName} ch=${payload.channel}: matched=${route.matched}`);

    // Gating: unmatched channels with gateUnmatched enabled
    if (shouldGate(config, route)) {
      dlog.debug(`gating unmatched channel ${payload.channel} for ${mindName}`);
      await this.gateMessage(mindName, route.session, payload);
      return { routed: true, session: route.session, mode: "gated" };
    }

    // Deferred: kept, not woken for — it rides along with the next turn on its thread.
    const deferral = this.deferDecision(baseName, config, route, payload);
    if (deferral) {
      dlog.debug(`deferring message on ${payload.channel} for ${mindName}/${deferral.session}`);
      if (await this.deferMessage(mindName, deferral.session, payload, deferral.until)) {
        return { routed: true, session: deferral.session, mode: "deferred" };
      }
      // No row to wait in means nothing to come back from: deliver it now rather than lose it.
      dlog.warn(`could not keep a deferred message for ${mindName}; delivering it now`);
    }

    // Resolve session name ($new expansion)
    let sessionName = route.session;
    if (sessionName === "$new") {
      sessionName = newEphemeralSession();
    }

    // Inbound-to-turn linking is exact: the delivery's own row, by its `historyId`, joins
    // the turn it runs in (`enterTurn`, `foldedRows`), so no time-window tagging is needed.

    // Resolve delivery mode for this session (pass matched rule for rule-level batch config)
    const sessionConfig = resolveDeliveryMode(config, sessionName, route.rule);

    if (sessionConfig.delivery.mode === "batch") {
      dlog.debug(`enqueueing batch message for ${mindName}/${sessionName}`);
      await this.enqueueBatch(mindName, sessionName, payload, sessionConfig);
      return { routed: true, session: sessionName, mode: "batch" };
    }

    // Immediate delivery — persist to the queue BEFORE the POST so a crash or a
    // failed POST leaves an at-least-once record the redrive loop can re-deliver.
    const queueId = await this.persistToQueue(mindName, sessionName, payload);
    await this.deliverToMind(mindName, sessionName, payload, sessionConfig, queueId);
    return { routed: true, session: sessionName, mode: "immediate" };
  }

  /**
   * Whether routing defers this message instead of letting it wake the mind, and if so,
   * which thread it waits on and when (epoch ms) it flushes on its own — undefined for
   * "only with the next turn on the thread". Deferral is `delivery: "defer"`, a
   * `mode: "mention"` non-mention, or a thread's `rateLimit` already spent. A message
   * arriving mid-turn on its thread folds into that turn rather than waking anything, so a
   * rate limit doesn't hold it back.
   *
   * A `$new` route has no next turn to ride along with — every message starts its own
   * thread — so what it defers waits on the mind's default thread instead.
   */
  private deferDecision(
    baseName: string,
    config: RoutingConfig,
    route: ResolvedRoute,
    payload: DeliveryPayload,
  ): { session: string; until?: number } | null {
    const session = route.session === "$new" ? (config.default ?? "main") : route.session;
    const sessionConfig = resolveDeliveryMode(config, route.session, route.rule);
    const routed = routingDefers(baseName, route, sessionConfig, payload);
    if (routed) {
      return {
        session,
        // From arrival: a message deferred overnight on the sleep queue is already due by
        // the time the wake flush gets here.
        until:
          routed.maxWaitMs != null
            ? (payload.deferred?.at ?? Date.now()) + routed.maxWaitMs
            : undefined,
      };
    }
    const rl = sessionConfig.rateLimit;
    if (rl && route.session !== "$new" && !hasTurnSlot(baseName, session)) {
      const freeAt = this.rateLimitFreesAt(baseName, session, rl);
      if (freeAt != null) return { session, until: freeAt };
    }
    return null;
  }

  /**
   * Whether a message would be deferred right now — the arrival-time prediction
   * `deliverMessage` uses to decide whether `mind_history` should record it yet (#420):
   * a deferred message hasn't reached the mind. Gated messages answer false; they have
   * their own rule. Explicit-session deliveries are never deferred.
   */
  async willDefer(mindName: string, payload: DeliveryPayload): Promise<boolean> {
    return (await this.deferralFor(mindName, payload)) != null;
  }

  /** {@link willDefer}, with the thread the message would wait on and its deadline. */
  async deferralFor(
    mindName: string,
    payload: DeliveryPayload,
  ): Promise<{ session: string; until?: number } | null> {
    if (payload.session) return null;
    const baseName = await getBaseName(mindName);
    const config = getRoutingConfig(baseName);
    const route = resolveRoute(config, await matchMetaFor(baseName, config, payload));
    if (shouldGate(config, route)) return null;
    return this.deferDecision(baseName, config, route, payload);
  }

  /**
   * Keep a message as `deferred` on `session`'s thread, flushing by itself at `until` if set.
   * Returns false when the row couldn't be written — the caller must then deliver the
   * message some other way, because nothing was kept.
   */
  async deferMessage(
    mindName: string,
    session: string,
    payload: DeliveryPayload,
    until?: number,
  ): Promise<boolean> {
    const before = payload.deferred;
    payload.deferred ??= { at: Date.now() };
    const id = await this.persistToQueue(mindName, session, payload, "deferred", until);
    if (id == null) payload.deferred = before;
    return id != null;
  }

  /**
   * Deliver a thread's deferred messages now, on their own — for a turn on the thread that
   * starts somewhere this class doesn't POST (a system event), called just before that POST
   * so they arrive first, the way they arrived first. A no-op when nothing is deferred there.
   * `turnId` is the turn the caller opened: they begin it, so the first of them is its
   * trigger. Returns whether anything was delivered.
   */
  async flushDeferred(mindName: string, session: string, turnId?: string): Promise<boolean> {
    const baseName = await getBaseName(mindName);
    const sessionConfig = resolveDeliveryMode(getRoutingConfig(baseName), session);
    return await this.deliverBatchToMind(mindName, session, [], sessionConfig, turnId);
  }

  /** When a full rate-limit window frees a wake (epoch ms), or null when it isn't full. */
  private rateLimitFreesAt(baseName: string, session: string, rl: RateLimit): number | null {
    const windowMs = rl.windowMinutes * 60_000;
    const now = Date.now();
    const key = `${baseName}:${session}`;
    const recent = (this.recentWakes.get(key) ?? []).filter((t) => now - t < windowMs);
    this.recentWakes.set(key, recent);
    if (recent.length < rl.max) return null;
    return recent[recent.length - rl.max] + windowMs;
  }

  /**
   * Count a delivery that started a turn on a rate-limited thread against its window.
   * Returns the entry, for {@link unnoteWake} if the delivery then fails — a POST the mind
   * never took woke nothing.
   */
  noteWake(
    baseName: string,
    session: string,
    sessionConfig: ResolvedSessionConfig = resolveDeliveryMode(getRoutingConfig(baseName), session),
  ): number | undefined {
    if (!sessionConfig.rateLimit) return undefined;
    const key = `${baseName}:${session}`;
    const list = this.recentWakes.get(key) ?? [];
    const at = Date.now();
    list.push(at);
    this.recentWakes.set(key, list);
    return at;
  }

  /** Remember that the concurrency gate is holding this row, for {@link waitFor}. */
  private noteGateWait(queueId: number, baseName: string): void {
    if (this.waitingSince.has(queueId)) return;
    const now = Date.now();
    // A row that is never delivered (dead-lettered, deleted by hand) would otherwise stay.
    for (const [id, w] of this.waitingSince) {
      if (now - w.since > 24 * 60 * 60_000) this.waitingSince.delete(id);
    }
    this.waitingSince.set(queueId, { since: now, behind: turnSlotHolders(baseName) });
  }

  /** The longest gate wait among these rows, if any was held. */
  private waitFor(queueIds: (number | undefined)[]): { ms: number; behind: string[] } | undefined {
    let first: { since: number; behind: string[] } | undefined;
    for (const id of queueIds) {
      const w = id != null ? this.waitingSince.get(id) : undefined;
      if (w && (!first || w.since < first.since)) first = w;
    }
    return first ? { ms: Date.now() - first.since, behind: first.behind } : undefined;
  }

  /** Take back a {@link noteWake} whose delivery failed. */
  unnoteWake(baseName: string, session: string, at: number | undefined): void {
    if (at == null) return;
    const list = this.recentWakes.get(`${baseName}:${session}`);
    const i = list?.indexOf(at) ?? -1;
    if (i >= 0) list!.splice(i, 1);
  }

  /**
   * If this delivery would start a turn on a thread whose `rateLimit` is spent, defer its
   * messages until the window frees a wake instead — never drop them. Returns whether it
   * did. Deferred messages already waiting on the thread past their own deadline are moved
   * to the same instant, so the sweep doesn't re-offer them every pass in the meantime.
   * A message with no queue row can't wait (there'd be nothing to come back from), so a
   * batch containing one goes out regardless.
   */
  private async parkIfRateLimited(
    baseName: string,
    session: string,
    messages: QueuedMessage[],
    sessionConfig: ResolvedSessionConfig,
  ): Promise<boolean> {
    const rl = sessionConfig.rateLimit;
    if (!rl || hasTurnSlot(baseName, session)) return false;
    if (messages.some((m) => m.queueId == null)) return false;
    const freeAt = this.rateLimitFreesAt(baseName, session, rl);
    if (freeAt == null) return false;
    dlog.debug(`rate limit reached on ${baseName}/${session}; deferring until ${freeAt}`);
    try {
      const db = await getDb();
      for (const msg of messages) {
        if (!msg.payload.deferred) {
          const row = await db
            .select({ created_at: deliveryQueue.created_at })
            .from(deliveryQueue)
            .where(eq(deliveryQueue.id, msg.queueId!))
            .get();
          msg.payload.deferred = {
            at: (row ? parseDbTimestamp(row.created_at)?.getTime() : undefined) ?? Date.now(),
          };
        }
        await db
          .update(deliveryQueue)
          .set({
            status: "deferred",
            next_attempt_at: toDbTimestamp(freeAt),
            payload: storedPayload(msg.payload),
          })
          .where(eq(deliveryQueue.id, msg.queueId!));
      }
      await db
        .update(deliveryQueue)
        .set({ next_attempt_at: toDbTimestamp(freeAt) })
        .where(
          and(
            eq(deliveryQueue.mind, baseName),
            eq(deliveryQueue.thread, session),
            eq(deliveryQueue.status, "deferred"),
            sql`${deliveryQueue.next_attempt_at} IS NOT NULL`,
            sql`${deliveryQueue.next_attempt_at} < ${toDbTimestamp(freeAt)}`,
          ),
        );
    } catch (err) {
      // Left `pending`: the sweep re-offers them, and this check runs again then.
      dlog.warn(`failed to defer rate-limited delivery to ${baseName}`, log.errorData(err));
    }
    return true;
  }

  /**
   * Claim the deferred messages waiting on (mind, thread), oldest first, to ride along with
   * a delivery that is about to go out there. Capped at {@link MAX_BATCH_SIZE}; the rest
   * ride with the turn after. Claimed rows are owned (`inFlight`) until the caller finishes.
   */
  private async takeDeferred(
    baseName: string,
    target: string,
    session: string,
  ): Promise<QueuedMessage[]> {
    let rows: (typeof deliveryQueue.$inferSelect)[];
    try {
      const db = await getDb();
      rows = await db
        .select()
        .from(deliveryQueue)
        .where(
          and(
            eq(deliveryQueue.mind, baseName),
            eq(deliveryQueue.thread, session),
            eq(deliveryQueue.status, "deferred"),
            sql`coalesce(${deliveryQueue.target_mind}, ${deliveryQueue.mind}) = ${target}`,
          ),
        )
        .orderBy(deliveryQueue.id)
        .limit(MAX_BATCH_SIZE);
    } catch (err) {
      dlog.warn(`failed to read deferred messages for ${baseName}/${session}`, log.errorData(err));
      return [];
    }
    const riders: QueuedMessage[] = [];
    for (const row of rows) {
      if (this.inFlight.has(row.id)) continue;
      let payload: DeliveryPayload;
      try {
        payload = queuedPayload(row);
      } catch (err) {
        // It can never be delivered, and left here it would be re-read on every delivery
        // to the thread. Dead-lettered, not deleted, so the row itself is still there to see.
        dlog.error(
          `dead-lettering unparseable deferred row ${row.id} for ${baseName}/${session}`,
          log.errorData(err),
        );
        try {
          const db = await getDb();
          await db
            .update(deliveryQueue)
            .set({ status: "dead", next_attempt_at: null })
            .where(eq(deliveryQueue.id, row.id));
        } catch (updateErr) {
          dlog.warn(`failed to dead-letter deferred row ${row.id}`, log.errorData(updateErr));
        }
        continue;
      }
      this.inFlight.add(row.id);
      riders.push({
        payload,
        channel: payload.channel,
        sender: payload.sender ?? null,
        createdAt: Date.now(),
        queueId: row.id,
        rider: true,
      });
    }
    return riders;
  }

  /**
   * Claim a thread's deferred messages for a delivery that POSTs outside this class (the
   * wake flush), so they can go in the same envelope, ahead of what it carries. The caller
   * must call `settle` exactly once with how the POST went: acked rows are deleted and
   * recorded in history, a rejection counts against each rider, and anything else leaves
   * them deferred.
   */
  async claimDeferred(
    mindName: string,
    session: string,
  ): Promise<{
    payloads: WirePayload[];
    /** Resolves to the riders' history rows, in envelope order, once recorded on an ack. */
    settle: (
      outcome: "acked" | "rejected" | "failed",
      turnId?: string,
    ) => Promise<(number | undefined)[]>;
  }> {
    const baseName = await getBaseName(mindName);
    const riders = await this.takeDeferred(baseName, mindName, session);
    return {
      payloads: riders.map((r) => withHeldPreface(r.payload)),
      settle: async (outcome, turnId) => {
        const ids = riders.map((r) => r.queueId!);
        try {
          if (outcome === "acked") {
            await this.deleteQueueRows(ids);
            for (const r of riders) {
              if (r.payload.inboundDeferred) {
                r.payload.historyId = await recordDeferredInbound(baseName, r.payload, turnId);
              }
            }
            return riders.map((r) => r.payload.historyId);
          }
          if (outcome === "rejected") await this.countRiderRejection(ids);
          return [];
        } finally {
          for (const id of ids) this.inFlight.delete(id);
        }
      },
    };
  }

  /**
   * The outstanding deliveries a `done` finishes — computed the moment it arrives, so a
   * delivery that lands while the `done` is still being handled is never swept up with it.
   *
   * Only the mind knows which deliveries a turn consumed — it may fold several into one
   * turn, run a queued one as a turn of its own, or fail one while another turn streams —
   * so its `done` says (`report.covers`). A count of deliveries against a count of `done`s
   * could not tell those apart (#1207).
   *
   * A `done` that ends a turn also finishes every delivery of its process that reached the
   * mind before the last one it names: a session runs its turns one at a time and in
   * order, so an older delivery still outstanding once a later one's turn has ended is one
   * the mind lost without saying (an interrupted turn, a stream that died) — never one still
   * to run. Without this, a single template path that forgot a delivery would hold the
   * session busy and its slot taken until the entry aged out.
   */
  coveredBy(mind: string, session: string | undefined, report: DoneReport): string[] {
    const ids: string[] = [];
    const sessions = session ? [session] : [...(this.sessionStates.get(mind)?.keys() ?? [])];
    for (const name of sessions) {
      const outstanding = this.sessionStates.get(mind)?.get(name)?.outstanding;
      if (!outstanding) continue;
      // A mind never reports a variant's deliveries, nor a variant its parent's: the two
      // share this state (keyed by base name) but not each other's turns.
      const own = [...outstanding].filter(([, d]) => d.process === report.process);
      if (!report.covers) {
        ids.push(...own.map(([id]) => id));
        continue;
      }
      const named = new Set(report.covers);
      if (report.messageId !== undefined) named.add(report.messageId);
      // `outstanding` is in the order the deliveries reached the mind.
      let last = -1;
      own.forEach(([id], i) => {
        if (named.has(id)) last = i;
      });
      own.forEach(([id], i) => {
        if (named.has(id) || (report.endsTurn && i <= last)) ids.push(id);
      });
    }
    return ids;
  }

  /**
   * Whether the daemon delivered `deliveryId` to `process` on this session and no `done` has
   * covered it — not even one that has arrived and is still being recorded (`retiring`).
   */
  isOutstanding(mind: string, session: string, deliveryId: string, process: string): boolean {
    const d = this.sessionStates.get(mind)?.get(session)?.outstanding.get(deliveryId);
    return d?.process === process && !d.retiring;
  }

  /** Whether `process` has any delivery on this session that no `done` has covered. */
  hasOutstanding(mind: string, session: string, process: string): boolean {
    for (const d of this.sessionStates.get(mind)?.get(session)?.outstanding.values() ?? []) {
      if (d.process === process && !d.retiring) return true;
    }
    return false;
  }

  /**
   * Called when a mind's session emits a "done" event: retires the deliveries it finished
   * (see `coveredBy`), frees the turn slot if the turn ended with nothing left to run, and
   * may trigger a batch flush if the session went idle. Without `retired` (a caller with no
   * `done` in hand), every outstanding delivery on the session is retired.
   *
   * This method is intentionally synchronous: the caller has already resolved baseName,
   * and an async yield here (e.g. getBaseName) would let a delivery that raced in after
   * the `done` be read as outstanding or not depending on scheduling.
   */
  sessionDone(
    baseName: string,
    session?: string,
    retired?: string[],
    /**
     * Whether a turn has ended — false for a `done` that only retires a delivery that failed
     * while a turn ran on beside it.
     */
    endedTurn = true,
  ): void {
    // A completed turn closes the mind's stale-send baselines so the next delivery re-snapshots.
    if (endedTurn) resetTurn(baseName);
    const mindSessions = this.sessionStates.get(baseName);
    const names = session ? [session] : [...(mindSessions?.keys() ?? [])];
    for (const name of names) this.retire(baseName, name, retired);
    if (endedTurn) {
      if (session) {
        // The turn is over: free the slot regardless of who took it — unless a delivery the
        // mind took is still outstanding, which it will run next as a turn of its own.
        if (!this.isSessionBusy(baseName, session)) releaseTurnSlot(baseName, session);
      } else {
        // Every session, including ones the mind ran without a delivery of ours (a system
        // event, a wake flush), which have a slot but no `sessionStates` entry.
        releaseTurnSlot(baseName);
      }
    }
    // A concurrency hold lifts the moment a turn ends, and the rows it held are still
    // `pending`. Without this the next sweep is up to REDRIVE_INTERVAL_MS away, which
    // would put 15s of dead air into every handoff. Fire-and-forget: `sessionDone` is
    // synchronous by design (see above) and redrive() coalesces overlapping sweeps.
    void this.redrive().catch((err) =>
      dlog.warn(`redrive after ${baseName} finished a turn failed`, log.errorData(err)),
    );
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
    // Coalesce concurrent sweeps. A sweep works from a snapshot and yields inside its
    // loop, so two overlapping passes can both act on a row the other already delivered
    // and deleted. Spend releases now trigger sweeps from three places on top of the
    // periodic timer, which makes the overlap routine rather than theoretical.
    //
    // Coalescing alone would drop the request, though, and joining an in-flight sweep is
    // not the same as being swept: that sweep already read its rows, so a caller whose
    // reason to sweep arose after the snapshot (a turn ending, which is what frees the
    // concurrency gate) would see nothing re-read and wait out the full interval anyway.
    // So an overlapping request queues exactly one trailing pass — enough to guarantee
    // every row is looked at after the event that prompted the call, and bounded, since
    // any number of requests during a sweep collapse into that single re-run.
    if (this.redriving) {
      this.redriveAgain ??= this.redriving.then(
        () => this.redrive(),
        () => this.redrive(),
      );
      return this.redriveAgain;
    }
    this.redriving = this.redriveInner().finally(() => {
      this.redriving = null;
      this.redriveAgain = null;
    });
    return this.redriving;
  }

  private async redriveInner(): Promise<void> {
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
        payload = queuedPayload(row);
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
        // A momentary hold (the concurrency gate) leaves the row `pending` — it is re-offered
        // on the next sweep, and the sweep that matters is the one `sessionDone` kicks off the
        // instant the turn ends. Moving it to `held` would strand it until a spend release ran.
        if (!hold.momentary) await this.holdRow(row.id, payload, hold);
        else this.noteGateWait(row.id, row.mind);
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
          attempts: row.attempts,
        });
      } else {
        this.deliverToMind(target, row.thread, payload, sessionConfig, row.id, row.attempts).catch(
          (err) => {
            dlog.warn(`failed to redrive delivery for ${target}`, log.errorData(err));
          },
        );
      }
      redriven++;
    }

    if (redriven > 0) dlog.info(`redrove ${redriven} pending delivery queue rows`);

    await this.flushDueDeferred();
  }

  /**
   * Deliver the threads whose deferred messages have reached their deadline — a `maxWait`,
   * or the moment a spent rate limit frees a wake — each as one batched turn (which carries
   * the thread's other deferred messages along too). A mind that isn't running, asleep
   * included, is skipped: its due messages go out on the first sweep after it's back.
   */
  private async flushDueDeferred(): Promise<void> {
    let due: { mind: string; target: string; thread: string }[];
    try {
      const db = await getDb();
      due = await db
        .selectDistinct({
          mind: deliveryQueue.mind,
          target: sql<string>`coalesce(${deliveryQueue.target_mind}, ${deliveryQueue.mind})`,
          thread: deliveryQueue.thread,
        })
        .from(deliveryQueue)
        .where(
          and(
            eq(deliveryQueue.status, "deferred"),
            sql`${deliveryQueue.next_attempt_at} IS NOT NULL AND ${deliveryQueue.next_attempt_at} <= datetime('now')`,
          ),
        )
        .limit(REDRIVE_BATCH_LIMIT);
    } catch (err) {
      dlog.warn("failed to read due deferred messages", log.errorData(err));
      return;
    }
    for (const { mind, target, thread } of due) {
      if (!this.isMindRunning(mind)) continue;
      const sessionConfig = resolveDeliveryMode(getRoutingConfig(mind), thread);
      this.deliverBatchToMind(target, thread, [], sessionConfig).catch((err) =>
        dlog.warn(`failed to flush deferred messages for ${target}/${thread}`, log.errorData(err)),
      );
    }
  }

  /**
   * Re-evaluate a mind's `gated` rows against its current routes.json when the routing
   * config changes. For each channel that now matches a route:
   *  - the newest {@link GATED_RELEASE_LIMIT_PER_CHANNEL} rows are promoted to `pending`
   *    and re-stamped with the freshly-resolved session (NOT the gate-time fallback), so
   *    they land in the correct session instead of `main` (#537 bug 1);
   *  - any older rows are `archived` (inert) so a long backlog can't flood the mind
   *    in one sweep (#537 bug 2), and the mind gets one summary rather than a flood.
   * Declined channels are skipped entirely — they stay gated.
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

  /**
   * Release a mind's spend-held messages, now that its cap no longer holds it.
   *
   * Bounded the same way a gated release is (#537 bug 2), and for a sharper reason: a day
   * of held traffic delivered in full would be one turn per message against a budget that
   * just reset, spending the new period in minutes and re-tripping the cap — the mind would
   * alternate between deaf and drowning and never reach the end of the backlog. So the
   * newest {@link HELD_RELEASE_LIMIT_PER_CHANNEL} per channel are promoted, the rest are
   * archived (inert, still readable in channel history), and the mind gets one summary
   * saying how many waited. Coming back to "here are ten things, and sixty more arrived"
   * is a description of a day; sixty turns is a denial of service.
   *
   * A no-op while the mind is still held — releasing on a cap that has not lifted would
   * hand it straight back. Serialized per mind on the same chain as gated releases: both
   * read rows and then write, and two overlapping runs would double-promote.
   */
  async releaseHeld(mindName: string): Promise<{ released: number; archived: number }> {
    const baseName = await getBaseName(mindName);
    const prev = this.releaseChains.get(baseName) ?? Promise.resolve();
    const run = prev.then(() => this.releaseHeldInner(baseName));
    const chain = run.then(
      () => undefined,
      () => undefined,
    );
    this.releaseChains.set(baseName, chain);
    try {
      return await run;
    } finally {
      if (this.releaseChains.get(baseName) === chain) this.releaseChains.delete(baseName);
    }
  }

  private async releaseHeldInner(
    baseName: string,
  ): Promise<{ released: number; archived: number }> {
    // The spend hold is per-mind, so one check answers for every held row. #823's
    // concurrency gate is momentary and never sets this status, so it has nothing to
    // release here — and must not stand in for a spend hold that has actually lifted,
    // or a mind that happens to be mid-turn would never get its backlog back.
    const stillHeld = this.holdCheck(baseName, "main");
    if (stillHeld && !stillHeld.momentary) return { released: 0, archived: 0 };

    let rows: (typeof deliveryQueue.$inferSelect)[];
    try {
      const db = await getDb();
      rows = await db
        .select()
        .from(deliveryQueue)
        .where(and(eq(deliveryQueue.mind, baseName), eq(deliveryQueue.status, "held")));
    } catch (err) {
      dlog.warn(`failed to read held rows for ${baseName}`, log.errorData(err));
      return { released: 0, archived: 0 };
    }
    if (rows.length === 0) return { released: 0, archived: 0 };

    const byChannel = new Map<string, (typeof rows)[number][]>();
    for (const row of rows) {
      const channel = row.channel ?? "unknown";
      const list = byChannel.get(channel) ?? [];
      list.push(row);
      byChannel.set(channel, list);
    }

    const promoteIds: number[] = [];
    const archiveIds: number[] = [];
    const notes: string[] = [];
    for (const [channel, items] of byChannel) {
      items.sort((a, b) => b.id - a.id); // newest first
      const keep = items.slice(0, HELD_RELEASE_LIMIT_PER_CHANNEL);
      const drop = items.slice(HELD_RELEASE_LIMIT_PER_CHANNEL);
      for (const k of keep) promoteIds.push(k.id);
      for (const d of drop) archiveIds.push(d.id);
      if (drop.length > 0) {
        notes.push(
          `${channel}: ${items.length} message(s) arrived while your spend cap was reached. ` +
            `The ${keep.length} most recent are on their way; the other ${drop.length} are not ` +
            `being replayed into your context, and remain readable with ` +
            `\`volute chat read ${channel}\`.`,
        );
      }
    }

    if (archiveIds.length > 0) {
      try {
        const db = await getDb();
        // Chunked against SQLite's ~999 bound-variable limit — this IS the flood-prevention
        // path, so it must not throw on a large backlog.
        for (let i = 0; i < archiveIds.length; i += 500) {
          await db
            .update(deliveryQueue)
            .set({ status: "archived" })
            .where(inArray(deliveryQueue.id, archiveIds.slice(i, i + 500)));
        }
      } catch (err) {
        dlog.warn(`failed to archive held rows for ${baseName}`, log.errorData(err));
      }
    }

    let released = 0;
    if (promoteIds.length > 0) {
      try {
        const db = await getDb();
        for (let i = 0; i < promoteIds.length; i += 500) {
          const chunk = promoteIds.slice(i, i + 500);
          await db
            .update(deliveryQueue)
            .set({ status: "pending", attempts: 0, next_attempt_at: null })
            .where(inArray(deliveryQueue.id, chunk));
          released += chunk.length;
        }
      } catch (err) {
        dlog.error(`failed to promote held rows for ${baseName}`, log.errorData(err));
        return { released: 0, archived: archiveIds.length };
      }
    }

    if (notes.length > 0) await this.sendHeldReleaseSummary(baseName, notes);
    if (released > 0) {
      dlog.info(
        `released ${released} held message(s) for ${baseName} (archived ${archiveIds.length})`,
      );
      await this.redrive();
    }
    return { released, archived: archiveIds.length };
  }

  /**
   * Release every mind whose spend hold has lifted. Driven off the rows themselves rather
   * than a mind list, because the install-wide cap holds minds that have no bucket of their
   * own — the rows are the only complete answer to "who is waiting".
   *
   * Also the boot sweep: a hold can lift while the daemon is down (a period rolls over, or a
   * host edits the cap), and nothing else would notice.
   */
  async releaseAllHeld(): Promise<void> {
    let minds: { mind: string }[];
    try {
      const db = await getDb();
      minds = await db
        .selectDistinct({ mind: deliveryQueue.mind })
        .from(deliveryQueue)
        .where(eq(deliveryQueue.status, "held"));
    } catch (err) {
      dlog.warn("failed to list minds with held messages", log.errorData(err));
      return;
    }
    for (const { mind } of minds) {
      try {
        await this.releaseHeld(mind);
      } catch (err) {
        dlog.warn(`failed to release held messages for ${mind}`, log.errorData(err));
      }
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
      senderId: number | null;
      content: string | null;
      payload: DeliveryPayload;
    };
    const byChannel = new Map<string, Promotable[]>();
    const archiveIds: number[] = [];

    for (const row of rows) {
      let payload: DeliveryPayload;
      try {
        payload = parseDeliveryPayload(row.payload);
      } catch {
        continue;
      }
      const route = resolveRoute(config, await matchMetaFor(baseName, config, payload));
      if (!route.matched) continue; // still unrouted → leave gated
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
        // From the persisted payload only — parseDeliveryPayload normalized a legacy
        // row's missing senderId to null (#1017).
        senderId: payload.senderId,
        content: extractTextContent(payload.content),
        payload,
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
          const [row] = await tx
            .insert(mindHistory)
            .values({
              mind: baseName,
              type: "inbound",
              channel: p.channel,
              sender: p.sender,
              sender_id: p.senderId,
              content: p.content,
            })
            .returning({ id: mindHistory.id });
          await tx
            .update(deliveryQueue)
            .set({
              status: "pending",
              thread: p.session,
              attempts: 0,
              next_attempt_at: null,
              // So the turn it is delivered into links exactly this row.
              payload: storedPayload({ ...p.payload, historyId: row?.id }),
            })
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

    // The mind owns routes.json and the daemon may be root: read and replace it through
    // the mind-file helpers, so a link or FIFO it planted refuses instead of aiming us.
    const dir = routesMindDir(baseName);
    const owner = await mindFileOwner(baseName);

    const targetThread = thread ?? "${channel}";
    let config: RoutingConfig = {};
    let rules: NonNullable<RoutingConfig["rules"]> = [];
    let ruleAdded = false;
    let parsed = false;
    try {
      // One read-modify-write under replaceMindFile's per-file lock, so an upsertEventRule or
      // migrateThreadBatchToDelivery landing between a separate read and replace isn't lost
      // (#1261). Write-then-rename: truncating in place means a crash mid-write leaves an
      // unparseable routes.json, which getRoutingConfig degrades to `{}` — and with
      // gateUnmatched defaulting on, that is a total delivery blackout for the mind.
      // A routes.json this creates is handed to the mind, which must own its routing.
      await replaceMindFile(
        dir,
        ROUTES_JSON,
        (text) => {
          // No routes.json yet ("") is fine — accept creates one. So is an empty file:
          // there is no routing in it to lose.
          const value: unknown = text.trim() ? JSON.parse(text) : {};
          // Valid JSON that isn't an object (an array — a shape this codebase has seen on
          // disk — or null, or a string) would let the rule silently vanish at stringify
          // time while we reported success. And an array-form config is exactly a mind with
          // no `rules`, i.e. one gating everything: the case this exists for.
          if (value == null || typeof value !== "object" || Array.isArray(value)) {
            throw new Error(`routes.json for ${baseName} is malformed (not a JSON object)`);
          }
          parsed = true;
          config = value as RoutingConfig;
          rules = Array.isArray(config.rules) ? config.rules : [];

          // Is the channel already routed? Ask the router rather than pattern-matching the
          // rules ourselves: a broader rule (`discord:*`) covers `discord:general` without
          // being equal to it, and appending a redundant rule *after* it would sit somewhere
          // it can never match — leaving `--thread` silently ineffective and the reported
          // thread a lie.
          ruleAdded = !resolveRoute({ ...config, rules }, { channel }).matched;
          if (!ruleAdded) return null;
          // Append: nothing matches the channel today, so a rule at the end can't be
          // shadowed, and the mind's own rule ordering is preserved.
          rules.push({ channel, thread: targetThread });
          config.rules = rules;
          return `${JSON.stringify(config, null, 2)}\n`;
        },
        { owner },
      );
    } catch (err) {
      // A routes.json that is there but malformed or unreadable (a link, a FIFO) must NOT be
      // overwritten: it's a mind-owned file and clobbering it would lose routing the
      // mind wrote by hand. A failure after a good parse (the write itself) is its own error.
      if (parsed) throw err;
      throw new Error(`routes.json for ${baseName} is unreadable or malformed — not modifying it`);
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
    const finalRoute = resolveRoute({ ...config, rules }, { channel });
    return {
      ruleAdded,
      thread: finalRoute.session,
      released,
      archived,
      known: match.known,
    };
  }

  /**
   * Read the messages held on a channel. Archived rows are
   * included: a truncated or declined backlog stays readable, which is what the invite and
   * release-summary texts promise. Gated messages have no conversation, so `volute chat
   * read` can't show them — this is the only way to see them.
   *
   * Returns the most recent {@link PEEK_LIMIT} messages (oldest-first within that window)
   * alongside the true total, so peeking at a spam channel with a huge backlog can't dump
   * all of it into the mind's context — the same reason releases are truncated. #537
   *
   * Given a `reader` (the peeking mind or variant, from one of its threads), the held rows
   * it was shown in full — addressed to it, and text only, since peek shows only text — are
   * stamped with that thread and when (the latest peek overwrites), and arrive prefaced with
   * that when their channel is routed (#1172). That note is the one thing a peek writes, and
   * it never costs the read: a failed stamp is logged, not thrown.
   */
  async peekChannel(
    mindName: string,
    channel: string,
    reader?: { name: string; thread: string },
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

    const shown = rows
      .sort((a, b) => a.id - b.id)
      .slice(-PEEK_LIMIT)
      .map((row) => {
        let payload: DeliveryPayload | null = null;
        try {
          payload = parseDeliveryPayload(row.payload);
        } catch {}
        return { row, payload };
      });

    // Stamp the rows the reader was shown in full and that are addressed to it: a variant's
    // peek marks rows sent to the variant, the parent's marks rows sent to the parent
    // (`target_mind` null or its name). Peek shows text only, so a message with any other
    // part was not shown in full.
    const ids = reader
      ? shown
          .filter(
            ({ row, payload }) =>
              row.status === "gated" &&
              (row.target_mind ?? baseName) === reader.name &&
              payload != null &&
              isTextOnly(payload.content),
          )
          .map(({ row }) => row.id)
      : [];
    if (reader && ids.length > 0) {
      try {
        // Not serialized with releases — a peek never waits behind one — and not
        // conditioned on `gated`: a release may have promoted a row since the read above,
        // and the mind has still been shown it. A row already delivered is gone.
        await db
          .update(deliveryQueue)
          .set({ peeked_at: sql`datetime('now')`, peeked_thread: reader.thread })
          .where(inArray(deliveryQueue.id, ids));
      } catch (err) {
        dlog.warn(`failed to record peek of ${channel} for ${baseName}`, log.errorData(err));
      }
    }

    const messages = shown.map(({ row, payload }) => ({
      sender: row.sender,
      content: payload ? extractTextContent(payload.content) : "(unreadable payload)",
      createdAt: row.created_at,
      status: row.status,
    }));

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
   * Note that a mind just read a routed conversation's latest messages with `volute chat
   * read`, from one of its threads. Its messages from that conversation still waiting to
   * be delivered — sitting in a batch buffer behind a busy turn, deferred, or held — and
   * shown in that read (created at or after `since`, the oldest message it returned, and
   * text only) are stamped like a gated peek, so they arrive prefaced with it rather than
   * met as new and answered twice. Never throws: a failed stamp costs a label, not the read.
   */
  async notePeekedInConversation(
    reader: { name: string; thread: string },
    conversationId: string,
    since: string,
  ): Promise<void> {
    try {
      const baseName = await getBaseName(reader.name);
      const db = await getDb();
      const rows = await db
        .select()
        .from(deliveryQueue)
        .where(
          and(
            eq(deliveryQueue.mind, baseName),
            inArray(deliveryQueue.status, ["pending", "deferred", "held"]),
            sql`${deliveryQueue.created_at} >= ${since}`,
            sql`json_extract(${deliveryQueue.payload}, '$.conversationId') = ${conversationId}`,
          ),
        );
      const ids = rows
        .filter((row) => {
          if ((row.target_mind ?? baseName) !== reader.name) return false;
          try {
            return isTextOnly(parseDeliveryPayload(row.payload).content);
          } catch {
            return false;
          }
        })
        .map((row) => row.id);
      if (ids.length === 0) return;
      await db
        .update(deliveryQueue)
        .set({ peeked_at: sql`datetime('now')`, peeked_thread: reader.thread })
        .where(inArray(deliveryQueue.id, ids));
    } catch (err) {
      dlog.warn(
        `failed to record read of ${conversationId} for ${reader.name}`,
        log.errorData(err),
      );
    }
  }

  /**
   * Attach each message's latest peek from its queue row. A buffered message's payload was
   * built when it arrived, so a peek stamped while it waited lives only on the row.
   */
  private async withRowPeeks<T extends { payload: DeliveryPayload; queueId?: number }>(
    messages: T[],
  ): Promise<T[]> {
    const ids = messages.map((m) => m.queueId).filter((id): id is number => id != null);
    if (ids.length === 0) return messages;
    try {
      const db = await getDb();
      const rows = await db
        .select({
          id: deliveryQueue.id,
          peeked_at: deliveryQueue.peeked_at,
          peeked_thread: deliveryQueue.peeked_thread,
        })
        .from(deliveryQueue)
        .where(inArray(deliveryQueue.id, ids));
      const peeks = new Map(
        rows
          .filter((r) => r.peeked_at && r.peeked_thread)
          .map((r) => [
            r.id,
            { thread: r.peeked_thread!, at: parseDbTimestamp(r.peeked_at!).getTime() },
          ]),
      );
      if (peeks.size === 0) return messages;
      return messages.map((m) => {
        const peeked = m.queueId != null ? peeks.get(m.queueId) : undefined;
        return peeked ? { ...m, payload: { ...m.payload, peeked } } : m;
      });
    } catch (err) {
      dlog.warn("failed to read peeks for a delivery", log.errorData(err));
      return messages;
    }
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
  /**
   * Tell a mind what waited and what is not being replayed, as a `next-turn` notice rather
   * than the channel event the gated release uses.
   *
   * Two reasons. It must arrive as context on the turn the released messages trigger — an
   * account of something that happened, not breaking news announced in its own turn. And a
   * `channel` event is one of the types a spend cap holds, so announcing the end of a hold
   * through one would be the announcement racing the thing it announces.
   */
  private async sendHeldReleaseSummary(baseName: string, notes: string[]): Promise<void> {
    const body = [
      "While your spend cap was reached, messages sent to you waited instead of being " +
        "delivered. The most recent are arriving now, each marked with when it came. " +
        "Nothing was deleted — what isn't being replayed is still in the channel:",
      "",
      ...notes.map((n) => `- ${n}`),
    ].join("\n");
    try {
      await this.notifyFailure({
        mind: baseName,
        thread: MIND_LEVEL_THREAD,
        kind: "budget",
        reason: "spend_hold_released",
        detail: body,
      });
    } catch (err) {
      dlog.warn(`failed to send held-release summary for ${baseName}`, log.errorData(err));
    }
  }

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
      const payload = parseDeliveryPayload(firstRow.payload);
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
    return (state?.outstanding.size ?? 0) > 0;
  }

  /**
   * Check if any session for a mind is currently busy.
   */
  isMindBusy(mindName: string): boolean {
    const mindSessions = this.sessionStates.get(mindName);
    if (!mindSessions) return false;
    for (const [, state] of mindSessions) {
      if (state.outstanding.size > 0) return true;
    }
    return false;
  }

  /**
   * Settle what a stopped variant leaves on its parent's threads. Delivery state, slots and
   * typing are kept under the base name, so the variant's own `clearMindSessions` reaches
   * none of it, and a parent's `done` beside the variant's turn left them to it (`readDone`).
   * Its outstanding deliveries go — it will never `done` them — and a thread no turn or
   * delivery now holds gets its slot back; the mind's typing indicator goes once nothing of
   * it is running or outstanding anywhere.
   */
  releaseStopped(process: string, orphaned: OrphanedTurn[]): void {
    const threads = new Set<string>();
    const touched: { mind: string; session: string }[] = [];
    const touch = (mind: string, session: string) => {
      const k = `${mind}\n${session}`;
      if (threads.has(k)) return;
      threads.add(k);
      touched.push({ mind, session });
    };
    for (const [mind, sessions] of this.sessionStates) {
      if (mind === process) continue;
      for (const [session, state] of sessions) {
        for (const [id, d] of [...state.outstanding]) {
          if (d.process !== process) continue;
          this.dropOutstanding(mind, session, id);
          touch(mind, session);
        }
      }
    }
    for (const { mind, session } of orphaned) {
      if (mind !== process && session) touch(mind, session);
    }
    const typingMap = getTypingMap();
    for (const { mind, session } of touched) {
      if (activeOwners(mind, session).length > 0 || this.isSessionBusy(mind, session)) continue;
      releaseTurnSlot(mind, session);
      const busy = [...(this.sessionStates.get(mind)?.keys() ?? [])].some((s) =>
        this.isSessionBusy(mind, s),
      );
      if (!busy && !hasActiveTurn(mind)) {
        publishTypingForChannels(typingMap.deleteSender(mind), typingMap);
      }
    }
  }

  /**
   * Clear all session state for a specific mind (called on mind stop/crash).
   * Resets active counts, clears typing indicators, and cleans up batch buffers
   * so ghost state doesn't accumulate.
   */
  clearMindSessions(mindName: string): void {
    this.sessionStates.delete(mindName);
    // A stopped or crashed mind never reports `done`, so its slots are freed here.
    releaseTurnSlot(mindName);
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
   * Forget a single session's outstanding deliveries.
   *
   * Used by the wedged-turn sweep: a turn stuck `active` after its `done` may have left
   * deliveries outstanding that no `done` will now cover. Once the sweep confirms the session
   * is genuinely idle, this clears them so the session stops reading busy. Batch buffers are
   * left intact — their own maxWait timer flushes any pending messages.
   *
   * `minIdleMs` guards against a race: if a delivery landed within that window, a fresh turn
   * may legitimately be in flight, so clearing would read it idle early. In that case we
   * skip — the next sweep retries if it's still wedged. Returns whether anything was reset.
   */
  forgetOutstanding(mindName: string, session: string, minIdleMs: number): boolean {
    const state = this.sessionStates.get(mindName)?.get(session);
    if (!state) return false;
    if (Date.now() - state.lastDeliveredAt < minIdleMs) return false;
    state.outstanding.clear();
    // A wedged session held a concurrency slot too; the sweep has just established the
    // session is idle, so releasing here is what stops the repair from leaving the mind
    // gated until the slot ages out.
    releaseTurnSlot(mindName, session);
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
   * Move a row into the `held` state: out of the redrive sweep entirely, and stamped with
   * when it arrived and which cap is holding it.
   *
   * `held` is a status rather than a flag on a `pending` row, for the same reason `gated`
   * is. The sweep reads `pending` rows id-ordered under a batch limit, so rows that cannot
   * move but stay eligible fill the window on every pass — one capped mind with a busy
   * channel would make every other mind's backlog unreachable, and after a daemon restart
   * the sweep is the *only* delivery path. Before this, squatting rows drained or
   * dead-lettered within half an hour; a daily cap would have made it the steady state.
   * Leaving the sweep also means release is deliberate: it goes through
   * {@link releaseHeld}, which bounds and records it, instead of a raw flood.
   *
   * The marker lives in the row's own payload JSON — the payload is already ours, and the
   * wait must survive a daemon restart, because a daily cap outlives one. Mutates
   * `payload` too, so the in-memory copy a batch buffer holds matches what is on disk.
   *
   * A row that already carries the marker was released once and is being held again —
   * the cap re-armed before the sweep reached it. It keeps its arrival time and takes the
   * new hold's scope, and its status moves to `held` like any other; leaving it `pending`
   * because it was marked would park it in the sweep window until the period reset (#962).
   */
  private async holdRow(
    queueId: number,
    payload: DeliveryPayload,
    hold: DeliveryHold,
  ): Promise<void> {
    // Whatever it waited on from here isn't another thread; the held preface says what it is.
    this.waitingSince.delete(queueId);
    try {
      const db = await getDb();
      let arrived = payload.held?.at;
      if (arrived == null) {
        // Stamp when the message ARRIVED, not when we first noticed it was held. Those are
        // the same instant only when the hold was already in force; a message that sat
        // pending through a mind restart, or waited out a batch window, would otherwise be
        // introduced to the mind as having turned up just now — the same lie about waiting
        // that the preface exists to prevent, told with a different number.
        const row = await db
          .select({ created_at: deliveryQueue.created_at })
          .from(deliveryQueue)
          .where(eq(deliveryQueue.id, queueId))
          .get();
        arrived = row ? parseDbTimestamp(row.created_at)?.getTime() : undefined;
      }
      payload.held = { at: arrived ?? Date.now(), scope: hold.scope, until: hold.until };
      await db
        .update(deliveryQueue)
        .set({ status: "held", payload: storedPayload(payload) })
        .where(eq(deliveryQueue.id, queueId));
    } catch (err) {
      // The row stays `pending` and is re-offered on the next sweep, where this is
      // retried. It is not delivered in the meantime — the sweep's own hold check still
      // holds it — so the failure costs a retry, not the cap.
      dlog.warn(`failed to hold delivery ${queueId}`, log.errorData(err));
    }
  }

  /** Delete delivered queue rows by their specific ids. */
  private async deleteQueueRows(ids: (number | undefined)[]): Promise<void> {
    const valid = [...new Set(ids.filter((id): id is number => typeof id === "number"))];
    if (valid.length === 0) return;
    for (const id of valid) this.waitingSince.delete(id);
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
    // A failed POST means the gate had let it through: a backoff is not time behind a thread.
    for (const id of valid) this.waitingSince.delete(id);
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

  /**
   * A batch the mind rejected may have been rejected because of a rider — so riders count
   * rejections toward {@link MAX_DELIVERY_ATTEMPTS} too, or one poison message would ride
   * along with, and sink, every delivery on its thread forever. On a deferred row
   * `next_attempt_at` is the deadline, so a backoff only ever moves an existing one later.
   */
  private async countRiderRejection(ids: number[]): Promise<void> {
    if (ids.length === 0) return;
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
        .where(and(inArray(deliveryQueue.id, ids), eq(deliveryQueue.status, "deferred")));
      const dead: DeadLetterRow[] = [];
      for (const row of rows) {
        const attempts = row.attempts + 1;
        if (attempts < MAX_DELIVERY_ATTEMPTS) {
          // A row with a deadline is re-offered by the sweep once it's due; push that back by
          // the usual backoff, or a failing mind would burn through the ceiling in minutes.
          // A row with none waits for the next turn on the thread as before.
          await db
            .update(deliveryQueue)
            .set({
              attempts,
              next_attempt_at: sql`CASE WHEN ${deliveryQueue.next_attempt_at} IS NULL THEN NULL ELSE max(${deliveryQueue.next_attempt_at}, ${this.backoffExpr(attempts)}) END`,
            })
            .where(eq(deliveryQueue.id, row.id));
          continue;
        }
        dlog.error(
          `dead-lettering deferred row ${row.id} for ${row.mind} after ${attempts} live ` +
            `rejections (channel=${row.channel ?? "?"}, sender=${row.sender ?? "?"})`,
        );
        const flipped = await db
          .update(deliveryQueue)
          .set({ attempts, status: "dead", next_attempt_at: null })
          .where(and(eq(deliveryQueue.id, row.id), eq(deliveryQueue.status, "deferred")))
          .returning({ id: deliveryQueue.id });
        if (flipped.length > 0) dead.push(row);
      }
      if (dead.length > 0) await this.notifyDeadLettered(dead);
    } catch (err) {
      dlog.error("failed to record rider rejection / dead-letter", log.errorData(err));
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
    /** Prior failed attempts on this row: a retry carries no riders (see `takeDeferred`). */
    attempts = 0,
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

      // A thread whose rate limit is spent defers this instead of waking the mind.
      const self: QueuedMessage = {
        payload,
        channel: payload.channel,
        sender: payload.sender ?? null,
        createdAt: Date.now(),
        queueId,
      };
      if (
        queueId != null &&
        (await this.parkIfRateLimited(baseName, session, [self], sessionConfig))
      ) {
        this.inFlight.delete(queueId);
        return;
      }
      // Deferred messages waiting on this thread ride along — before the hold check, which
      // must stay in the same tick as the slot claim below.
      const riders = attempts > 0 ? [] : await this.takeDeferred(baseName, mindName, session);

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
        for (const r of riders) this.inFlight.delete(r.queueId!);
        if (!hold.momentary) await this.holdRow(queueId, payload, hold);
        else this.noteGateWait(queueId, baseName);
        this.inFlight.delete(queueId);
        return;
      }
      if (hold) {
        dlog.warn(
          `delivering to ${baseName}/${session} despite a ${hold.reason} hold: the message ` +
            `has no delivery_queue row, so holding it would drop it`,
        );
        // That exception is for this message alone; what's deferred keeps waiting.
        for (const r of riders.splice(0)) this.inFlight.delete(r.queueId!);
      }

      // With riders, this goes out as one batch envelope: the waiting messages first, in
      // the order they arrived, then the one that caused the turn.
      if (riders.length > 0) {
        await this.postBatch(mindName, baseName, port, session, [...riders, self], sessionConfig);
        return;
      }

      // Increment active count before delivery with sender/channel metadata
      const senders = new Set<string>();
      if (payload.sender) senders.add(payload.sender);
      const channels = new Set<string>();
      if (payload.channel) channels.add(payload.channel);
      const deliveryId = randomUUID();
      const ownsSlot = this.addOutstanding(
        baseName,
        session,
        deliveryId,
        mindName,
        senders,
        channels,
        [payload.historyId],
      );
      const wakeAt = ownsSlot ? this.noteWake(baseName, session, sessionConfig) : undefined;
      const typingMap = getTypingMap();

      // From here the row and (maybe) the turn slot are ours; a throw before the POST must
      // hand both back, or the slot gates the mind until its TTL.
      let posting = false;
      let entered: EnteredTurn | undefined;
      try {
        entered = await this.enterTurn(
          baseName,
          session,
          mindName,
          deliveryId,
          ownsSlot,
          [payload.historyId],
          sessionConfig.interrupt === true,
        );

        // Snapshot the stale-send baseline: the latest message this mind has now seen in
        // the conversation, so a reply it composes can be held if a peer posts after this.
        // Awaited so the baseline is set before the mind can receive-and-reply.
        await onDeliveredToMind(baseName, payload.conversationId);

        // Set typing indicator on both slug and conversationId keys, and publish the
        // conversationId key so the web UI learns the mind is typing at delivery time
        // (not incidentally via an unrelated re-publish).
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
        const [peeked] = await this.withRowPeeks([{ payload, queueId }]);
        const enriched = await this.enrichWithProfiles(baseName, session, peeked.payload);
        const enrichedPayload = withAvatars(
          withSinceNote(
            withHeldPreface(enriched.payload),
            // A turn this message starts opens with what the mind's other threads did in
            // between (#939). One that folds into a running turn adds nothing.
            ownsSlot
              ? await sinceNoteFor(mindName, {
                  mind: baseName,
                  thread: session,
                  channels: [payload.channel],
                  conversationIds: [payload.conversationId],
                  waited: this.waitFor([queueId]),
                })
              : null,
          ),
          enriched.avatars,
        );

        const body = JSON.stringify({
          ...enrichedPayload,
          session,
          deliveryId,
          instructions: sessionConfig.instructions,
          interrupt: sessionConfig.interrupt,
          replyInstructions: sessionConfig.replyInstructions,
        });

        posting = true;
        const ok = await this.postToMind(port, body);
        if (!ok) {
          // Reachable but rejected (non-OK HTTP) → a live rejection that counts toward the ceiling.
          this.dropOutstanding(baseName, session, deliveryId);
          // Refused, it interrupted nothing.
          if (entered?.interrupted) unmarkInterrupted(entered.turnId, deliveryId);
          // Its turn first, synchronously: the slot must not reach a waiter that would join it.
          // Only a turn it opened: in one it folded into, the mind may have read it before
          // refusing, and its sender must stay visible to authority checks (#433).
          if (entered?.created) {
            this.unfold(baseName, session, entered.turnId);
            void unlinkRefused(baseName, entered.turnId, [payload.historyId], entered.created);
          }
          // No turn ran, so give the slot back — but only if this delivery took it. A
          // message that folded into a turn already running does not own that turn's slot,
          // and freeing it would open the gate while the mind is still working.
          if (ownsSlot) releaseTurnSlot(baseName, session);
          this.unnoteWake(baseName, session, wakeAt);
          publishTypingForChannels(typingMap.deleteSender(baseName), typingMap);
          await this.scheduleRetry([queueId], { liveRejection: true });
        } else {
          // Mark delivered ONLY on ack, by specific row id — never a broad DELETE.
          await this.deleteQueueRows([queueId]);
          // A message whose inbound row was deferred because the mind was over its cap is
          // recorded now, when it has actually been received. Recording on ack rather than
          // at release means a promoted row that then fails to deliver still doesn't claim
          // the mind heard it (#420).
          if (payload.inboundDeferred) {
            payload.historyId = await recordDeferredInbound(baseName, payload, entered?.turnId);
          }
          this.linkAcked(baseName, session, mindName, deliveryId, entered, [payload.historyId]);
        }
      } catch (err) {
        // Threw at the POST → transport failure (mind/variant down or timed out), NOT a live
        // rejection. Threw before it → nothing was sent; the row stays for the sweep.
        dlog.warn(
          `failed to ${posting ? "deliver" : "prepare delivery"} to ${mindName}`,
          log.errorData(err),
        );
        const sent = posting && !isConnectionRefused(err);
        this.dropOutstanding(baseName, session, deliveryId);
        if (entered?.interrupted && !sent) unmarkInterrupted(entered.turnId, deliveryId);
        // Only if nothing was sent: a POST that failed to answer may be running, and stays —
        // the next delivery folds into it, and the mind's `done` settles it. A refused
        // connection sent nothing (see `isConnectionRefused`).
        if (entered && !sent) {
          if (entered.created) this.unfold(baseName, session, entered.turnId);
          void unlinkRefused(baseName, entered.turnId, [payload.historyId], entered.created);
        }
        if (ownsSlot) releaseTurnSlot(baseName, session);
        this.unnoteWake(baseName, session, wakeAt);
        publishTypingForChannels(typingMap.deleteSender(baseName), typingMap);
        if (posting) await this.scheduleRetry([queueId], { liveRejection: false });
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
    turnId?: string,
  ): Promise<boolean> {
    const queueIds = messages
      .map((m) => m.queueId)
      .filter((id): id is number => typeof id === "number");

    // Serialize the whole batch delivery per (mind, session) so it can't be
    // reordered against interleaving immediate deliveries to the same session.
    return await this.runSequential(`${mindName}:${session}`, async () => {
      const resolved = await this.resolvePort(mindName);
      if (!resolved) {
        dlog.warn(`cannot deliver batch to ${mindName}: mind not found`);
        // Leave rows pending for redrive; release ownership so the sweep can retry.
        for (const id of queueIds) this.inFlight.delete(id);
        return false;
      }
      const { baseName, port } = resolved;

      if (await this.parkIfRateLimited(baseName, session, messages, sessionConfig)) {
        for (const id of queueIds) this.inFlight.delete(id);
        return false;
      }
      // Taken before the hold check, which must stay in the same tick as `postBatch`'s slot
      // claim (see there). A retry carries none: if the mind is rejecting it, riders would
      // only be sunk along with it.
      const riders = messages.some((m) => (m.attempts ?? 0) > 0)
        ? []
        : await this.takeDeferred(baseName, mindName, session);

      // Held? Same as the immediate path: the whole batch stays `pending` and untouched.
      // A batch is delivered as one envelope, so it is held only when every message in it
      // has a row to be held in — otherwise the unpersisted ones would have nothing to come
      // back from, and a hold would quietly become a deletion. Riders just stay deferred.
      const hold = this.holdCheck(baseName, session);
      if (hold && queueIds.length === messages.length) {
        dlog.debug(
          `holding batch of ${messages.length} to ${baseName}/${session} (${hold.reason})`,
        );
        for (const r of riders) this.inFlight.delete(r.queueId!);
        if (!hold.momentary) {
          for (const msg of messages) await this.holdRow(msg.queueId!, msg.payload, hold);
        } else {
          for (const id of queueIds) this.noteGateWait(id, baseName);
        }
        // The buffer is dropped either way: the rows stay in the queue, and redrive
        // rebuilds the batch when the hold lifts.
        for (const id of queueIds) this.inFlight.delete(id);
        return false;
      }
      if (hold) {
        dlog.warn(
          `delivering a batch to ${baseName}/${session} despite a ${hold.reason} hold: ` +
            `${messages.length - queueIds.length} message(s) have no delivery_queue row, ` +
            `so holding the batch would drop them`,
        );
        for (const r of riders.splice(0)) this.inFlight.delete(r.queueId!);
      }

      return await this.postBatch(
        mindName,
        baseName,
        port,
        session,
        [...riders, ...messages],
        sessionConfig,
        turnId,
      );
    });
  }

  /**
   * POST `messages` to a mind as one batch envelope and settle their rows: deleted on ack,
   * retried on failure. Riders (deferred messages carried along) are deleted on ack too, but
   * a failure leaves them `deferred`, untouched — they weren't what this delivery was for.
   * Runs inside the caller's `runSequential`, called in the same tick as its hold check.
   */
  private async postBatch(
    mindName: string,
    baseName: string,
    port: number,
    session: string,
    messages: QueuedMessage[],
    sessionConfig: ResolvedSessionConfig,
    /** A turn the caller opened for this batch to begin (see `flushDeferred`). */
    turnId?: string,
  ): Promise<boolean> {
    const queueIds = messages
      .map((m) => m.queueId)
      .filter((id): id is number => typeof id === "number");
    const retryIds = messages.filter((m) => !m.rider).map((m) => m.queueId);
    const riderIds = messages.filter((m) => m.rider).map((m) => m.queueId!);
    if (messages.length === 0) return false;

    // Claim the slot HERE, in the same tick as the gate check — not at `addOutstanding`
    // below, which sits behind an `await` on profile enrichment. `runSequential` keys on
    // (mind, session), so two sessions of one mind are not serialized against each other,
    // and two batch buffers flushing in the same tick would otherwise both pass a gate
    // neither had claimed. Idempotent, so the later `addOutstanding` only records the
    // delivery — its own claim of the slot is a no-op.
    const ownsSlot = acquireTurnSlot(baseName, session);
    const wakeAt = ownsSlot ? this.noteWake(baseName, session, sessionConfig) : undefined;

    // From here these rows and (maybe) the turn slot are ours; anything that throws before
    // the POST must hand both back, or the rows are skipped by every sweep and the slot
    // gates the mind until its TTL.
    const deliveryId = randomUUID();
    let incremented = false;
    let posting = false;
    let acked = false;
    let entered: EnteredTurn | undefined;
    const rowIds = () => messages.map((m) => m.payload.historyId);
    try {
      // Enrich first message per new channel with participant profiles
      const firstPerChannel = new Set<string>();
      const isFirstForChannel: boolean[] = [];
      for (const msg of messages) {
        const ch = msg.channel ?? "unknown";
        isFirstForChannel.push(!firstPerChannel.has(ch));
        firstPerChannel.add(ch);
      }
      const avatarsByMessage: AvatarBlock[][] = messages.map(() => []);
      const enrichedMessages = await Promise.all(
        (await this.withRowPeeks(messages)).map(async (msg, i) => {
          if (!isFirstForChannel[i]) return msg;
          const enriched = await this.enrichWithProfiles(baseName, session, msg.payload);
          avatarsByMessage[i] = enriched.avatars;
          return { ...msg, payload: enriched.payload };
        }),
      ).then((msgs) => msgs.map((m) => ({ ...m, payload: withHeldPreface(m.payload) })));
      // A turn this batch starts opens with what the mind's other threads did in between
      // (#939), on its first message — the one the mind reads first. A batch that folds into
      // a running turn adds nothing.
      if (ownsSlot) {
        const note = await sinceNoteFor(mindName, {
          mind: baseName,
          thread: session,
          channels: messages.map((m) => m.channel),
          conversationIds: messages.map((m) => m.payload.conversationId),
          waited: this.waitFor(messages.map((m) => m.queueId)),
        });
        enrichedMessages[0] = {
          ...enrichedMessages[0],
          payload: withSinceNote(enrichedMessages[0].payload, note),
        };
      }
      for (let i = 0; i < enrichedMessages.length; i++) {
        enrichedMessages[i] = {
          ...enrichedMessages[i],
          payload: withAvatars(enrichedMessages[i].payload, avatarsByMessage[i]),
        };
      }

      // Group messages by channel
      const channels: Record<string, WirePayload[]> = {};
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

      // Increment active count with metadata (the slot was claimed above).
      this.addOutstanding(baseName, session, deliveryId, mindName, senders, channelSet, rowIds());
      // The turn it runs in, before the mind sees it: a caller's turn this batch begins
      // (`flushDeferred`), or the one `enterTurn` finds.
      if (turnId) {
        entered = { turnId, created: false, folded: false };
        if (messages[0].payload.historyId != null) await linkRowsToTurn(turnId, rowIds());
      } else {
        entered = await this.enterTurn(
          baseName,
          session,
          mindName,
          deliveryId,
          ownsSlot,
          rowIds(),
          sessionConfig.interrupt === true,
        );
      }
      incremented = true;

      // Snapshot the stale-send baseline per conversation in this batch (see deliverToMind).
      const convIds = new Set<string>();
      for (const msg of messages) {
        if (msg.payload.conversationId) convIds.add(msg.payload.conversationId);
      }
      for (const convId of convIds) {
        await onDeliveredToMind(baseName, convId);
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
        deliveryId,
        batch: { channels },
        instructions: sessionConfig.instructions,
        interrupt: sessionConfig.interrupt,
        replyInstructions: sessionConfig.replyInstructions,
      });

      posting = true;
      try {
        const ok = await this.postToMind(port, body);
        if (!ok) {
          // Reachable but rejected (non-OK HTTP) → a live rejection that counts toward the ceiling.
          this.dropOutstanding(baseName, session, deliveryId);
          // Refused, it interrupted nothing.
          if (entered?.interrupted) unmarkInterrupted(entered.turnId, deliveryId);
          // Only if this batch took the slot — see the immediate path.
          if (entered?.created) {
            this.unfold(baseName, session, entered.turnId);
            void unlinkRefused(baseName, entered.turnId, rowIds(), entered.created);
          } else if (turnId) {
            // Riders ahead of an event, refused: not the event's turn's, but their own turn's
            // when they are sent again.
            void unlinkRefused(baseName, turnId, rowIds(), false);
          }
          if (ownsSlot) releaseTurnSlot(baseName, session);
          this.unnoteWake(baseName, session, wakeAt);
          publishTypingForChannels(typingMap.deleteSender(baseName), typingMap);
          await this.scheduleRetry(retryIds, { liveRejection: true });
          await this.countRiderRejection(riderIds);
        } else {
          // Mark delivered ONLY on ack, and ONLY the specific rows in this batch —
          // a broad (mind, session, pending) DELETE would race with rows enqueued
          // concurrently during the flush.
          acked = true;
          await this.deleteQueueRows(queueIds);
          for (const msg of messages) {
            if (!msg.payload.inboundDeferred) continue;
            msg.payload.historyId = await recordDeferredInbound(
              baseName,
              msg.payload,
              entered?.turnId,
            );
          }
          this.linkAcked(baseName, session, mindName, deliveryId, entered, rowIds());
        }
      } catch (err) {
        // Threw → transport failure (mind/variant down or timed out), NOT a live rejection.
        dlog.warn(`failed to deliver batch to ${mindName}`, log.errorData(err));
        this.dropOutstanding(baseName, session, deliveryId);
        // A POST that failed to answer may be running: its turn stays. A refused connection
        // sent nothing (see `isConnectionRefused`), so it is taken back like one never sent.
        if (isConnectionRefused(err)) {
          if (entered?.interrupted) unmarkInterrupted(entered.turnId, deliveryId);
          if (entered) {
            if (entered.created) this.unfold(baseName, session, entered.turnId);
            void unlinkRefused(baseName, entered.turnId, rowIds(), entered.created);
          }
        }
        if (ownsSlot) releaseTurnSlot(baseName, session);
        this.unnoteWake(baseName, session, wakeAt);
        publishTypingForChannels(typingMap.deleteSender(baseName), typingMap);
        await this.scheduleRetry(retryIds, { liveRejection: false });
      }
      return acked;
    } catch (err) {
      // The POST path settles its own failures; this is a throw before it got there.
      if (posting) throw err;
      dlog.warn(`failed to prepare batch for ${mindName}/${session}`, log.errorData(err));
      if (incremented) this.dropOutstanding(baseName, session, deliveryId);
      // It never reached the mind, so it interrupted nothing.
      if (entered?.interrupted) unmarkInterrupted(entered.turnId, deliveryId);
      if (entered) {
        if (entered.created) this.unfold(baseName, session, entered.turnId);
        void unlinkRefused(baseName, entered.turnId, rowIds(), entered.created);
      }
      if (ownsSlot) releaseTurnSlot(baseName, session);
      this.unnoteWake(baseName, session, wakeAt);
      return false;
    } finally {
      for (const id of queueIds) this.inFlight.delete(id);
    }
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
    status: "pending" | "gated" | "archived" | "deferred" = "pending",
    /** For a `deferred` row: when it flushes by itself (epoch ms). Null = never on its own. */
    until?: number,
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
          payload: storedPayload(payload),
          next_attempt_at: until != null ? toDbTimestamp(until) : null,
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
  ): Promise<{ payload: DeliveryPayload; avatars: AvatarBlock[] }> {
    const none = { payload, avatars: [] };
    if (!payload.conversationId || !payload.channel) return none;
    const mindSessions = this.sessionStates.get(mindName);
    const state = mindSessions?.get(session);
    if (!state) return none;

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

    if (profilesSeen && !freshChannelInfo) return none;

    try {
      const enriched: DeliveryPayload = { ...payload };
      let avatars: AvatarBlock[] = [];

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

        // Avatar images go back separately: the caller prepends them last (withAvatars)
        avatars = await this.loadAvatarBlocks(participants);
        state.seenChannelProfiles.add(channelKey);
      }

      return { payload: enriched, avatars };
    } catch (err) {
      dlog.warn(`failed to fetch participant profiles for ${mindName}`, log.errorData(err));
      return none;
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
        let avatar: { path: string; data: Buffer } | null;
        if (isMind(p)) {
          avatar = await readMindAvatar(p.username);
          if (!avatar) continue;
        } else {
          const path = resolve(voluteHome(), "avatars", p.avatar);
          avatar = { path, data: await readFile(path) };
        }

        const rendered = await renderAvatarBlock(avatar.path, avatar.data, p.username);
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

  /** Returns whether this delivery is the one that started the turn — see acquireTurnSlot. */
  private addOutstanding(
    mind: string,
    session: string,
    deliveryId: string,
    process: string,
    senders?: Set<string>,
    channels?: Set<string>,
    rows: (number | undefined)[] = [],
  ): boolean {
    let mindSessions = this.sessionStates.get(mind);
    if (!mindSessions) {
      mindSessions = new Map();
      this.sessionStates.set(mind, mindSessions);
    }
    const state = mindSessions.get(session) ?? {
      outstanding: new Map<string, Outstanding>(),
      lastDeliveredAt: 0,
      lastDeliverySenders: new Set<string>(),
      lastDeliveryChannels: new Set<string>(),
      seenChannelProfiles: new Set<string>(),
      announcedChannelInfo: new Map<string, string>(),
    };
    state.outstanding.set(deliveryId, { process, rows });
    // Take the concurrency slot in the same tick as the gate check above it, so two
    // deliveries can't both pass a gate neither has yet claimed against.
    const owned = acquireTurnSlot(mind, session);
    state.lastDeliveredAt = Date.now();
    if (senders) state.lastDeliverySenders = senders;
    if (channels) state.lastDeliveryChannels = channels;
    mindSessions.set(session, state);
    return owned;
  }

  /**
   * Link an acked delivery that found the turn slot taken. While it is outstanding it joins
   * the running turn — so the turn's senders are known to authority checks while it runs —
   * and its rows are kept on it: if the `done` that ends that turn does not cover it, the
   * mind runs it as a turn of its own, and its rows move there (`foldedRows`). Once a `done`
   * has retired it, its rows go to the turn that ran it, and nothing opens.
   */
  private linkFolded(
    mind: string,
    session: string,
    process: string,
    deliveryId: string,
    rows: (number | undefined)[],
  ): void {
    const d = this.sessionStates.get(mind)?.get(session)?.outstanding.get(deliveryId);
    if (d) {
      // The turn it folded into before its POST, if any — not whatever runs by the ack. With
      // none, its rows wait for the turn it runs in (`foldedRows`).
      if (d.foldedInto) void linkRowsToTurn(d.foldedInto, rows, { trigger: false });
    } else {
      const ran = closedTurnFor(session, process, deliveryId);
      if (ran) void linkRowsToTurn(ran, rows, { trigger: false });
    }
  }

  /**
   * Put a delivery into the turn it runs in, before it is POSTed: the turn it starts, if it
   * took the slot — its first row the trigger — or the turn it folds into, so authority
   * checks see its sender from the moment the mind can. A first row only written on the ack
   * (a rider's) waits for it, so the trigger is the first message the mind reads. Undo it
   * with `unlinkRefused` if the mind definitely refuses the POST.
   */
  private async enterTurn(
    mind: string,
    session: string,
    process: string,
    deliveryId: string,
    ownsSlot: boolean,
    rows: (number | undefined)[],
    /** It is POSTed to interrupt the turn it lands in, if one is running. */
    interrupts: boolean,
  ): Promise<EnteredTurn | undefined> {
    const d = this.sessionStates.get(mind)?.get(session)?.outstanding.get(deliveryId);
    let into: string | undefined;
    if (ownsSlot) {
      const opened = await openDeliveredTurn(mind, session, process);
      if (!opened) return undefined;
      if (opened.created) {
        if (rows[0] != null) await linkRowsToTurn(opened.turnId, rows);
        this.adoptUnlinked(mind, session, process, opened.turnId, deliveryId);
        return { turnId: opened.turnId, created: true, folded: false };
      }
      // Joined a turn of its own process already running: a fold in all but name.
      into = opened.turnId;
    } else {
      into = getActiveTurnId(mind, session, process);
    }
    if (d) d.foldedInto = into;
    if (!into) return undefined;
    // The turn it interrupts ends without an answer; it is not a quiet one (see summarizer).
    if (interrupts) markInterrupted(into, deliveryId);
    await linkRowsToTurn(into, rows, { trigger: false });
    return { turnId: into, created: false, folded: true, interrupted: interrupts };
  }

  /**
   * Track a delivery POSTed outside this class (the wake flush) as one of its own: outstanding
   * until a `done` covers it, and put into the turn it runs in (`enterTurn`), so a batch the
   * mind folds in or runs as a turn of its own is followed like any other (#1298). The
   * caller must POST it with `deliveryId` and report how that went with `endDirect`.
   */
  async beginDirect(
    baseName: string,
    session: string,
    process: string,
    deliveryId: string,
    ownsSlot: boolean,
    rows: (number | undefined)[],
  ): Promise<EnteredTurn | undefined> {
    this.addOutstanding(baseName, session, deliveryId, process, undefined, undefined, rows);
    return this.enterTurn(baseName, session, process, deliveryId, ownsSlot, rows, false);
  }

  /** How a `beginDirect` delivery's POST went; `rows` as they stand after it. */
  endDirect(
    baseName: string,
    session: string,
    process: string,
    deliveryId: string,
    entered: EnteredTurn | undefined,
    outcome: "acked" | "rejected" | "failed" | "unsent",
    rows: (number | undefined)[],
  ): void {
    if (outcome === "acked") {
      this.linkAcked(baseName, session, process, deliveryId, entered, rows);
      return;
    }
    this.dropOutstanding(baseName, session, deliveryId);
    // Never sent, or a turn it opened refused. A POST that failed to answer may be running,
    // and a refused fold may have been read: those stay (#433).
    if (entered && (outcome === "unsent" || (outcome === "rejected" && entered.created))) {
      if (entered.created) this.unfold(baseName, session, entered.turnId);
      void unlinkRefused(baseName, entered.turnId, rows, entered.created);
    }
  }

  /** Link what an acked delivery's ack wrote, now the mind has it (see `enterTurn`). */
  private linkAcked(
    mind: string,
    session: string,
    process: string,
    deliveryId: string,
    entered: EnteredTurn | undefined,
    rows: (number | undefined)[],
  ): void {
    this.keepRows(mind, session, deliveryId, rows);
    if (entered && !entered.folded) {
      // A turn it opened also takes what a turn interrupted there left (only now the mind
      // has the message: a refused one must not carry them off).
      const turnId = entered.turnId;
      void linkRowsToTurn(turnId, rows).then(() =>
        entered.created ? adoptInterrupted(mind, session, process, turnId) : undefined,
      );
    } else this.linkFolded(mind, session, process, deliveryId, rows);
  }

  /**
   * A turn just opened takes `process`'s outstanding deliveries that found no turn to join
   * when they reached the mind — delivered in the moment the slot was taken but the turn
   * not yet open. The mind has them, so they are in this turn's context, and their senders
   * must count toward its authority (#433). Never the trigger.
   */
  adoptUnlinked(
    mind: string,
    session: string,
    process: string,
    turnId: string,
    except?: string,
  ): void {
    const rows: (number | undefined)[] = [];
    for (const [id, d] of this.sessionStates.get(mind)?.get(session)?.outstanding ?? []) {
      if (id === except || d.process !== process || d.retiring || d.foldedInto) continue;
      d.foldedInto = turnId;
      rows.push(...d.rows);
    }
    if (rows.length > 0) void linkRowsToTurn(turnId, rows, { trigger: false });
  }

  /** A turn was taken back unrun: what folded into it waits for the turn it runs in. */
  unfold(mind: string, session: string, turnId: string): void {
    for (const d of this.sessionStates.get(mind)?.get(session)?.outstanding.values() ?? []) {
      if (d.foldedInto === turnId) d.foldedInto = undefined;
    }
  }

  /**
   * The delivery `process` is running on the session when it has no turn there: its oldest
   * outstanding one that no `done` has covered — the mind runs them in the order they came.
   * What it sends or reports meanwhile is stamped with it, for the turn recorded at that
   * delivery's `done` to take (#1320).
   */
  runningDelivery(mind: string, session: string, process: string): string | undefined {
    for (const [id, d] of this.sessionStates.get(mind)?.get(session)?.outstanding ?? []) {
      if (d.process === process && !d.retiring) return id;
    }
    return undefined;
  }

  /** Note that a `done` has covered these deliveries, on its arrival (see `Outstanding`). */
  markRetiring(mind: string, session: string, ids: string[]): void {
    const outstanding = this.sessionStates.get(mind)?.get(session)?.outstanding;
    for (const id of ids) {
      const d = outstanding?.get(id);
      if (d) d.retiring = true;
    }
  }

  /** Keep an acked delivery's rows on it, now those written on the ack exist too. */
  private keepRows(
    mind: string,
    session: string,
    deliveryId: string,
    rows: (number | undefined)[],
  ): void {
    const d = this.sessionStates.get(mind)?.get(session)?.outstanding.get(deliveryId);
    if (d) d.rows = rows;
  }

  /**
   * The rows of `process`'s outstanding deliveries on the session — only `ids`, if given —
   * in the order they reached the mind, and the turns they were linked to when they folded
   * in. For a turn opening on the session: these are what it runs (see `linkRowsToTurn`).
   */
  foldedRows(
    mind: string,
    session: string,
    process: string,
    ids: string[] | undefined,
    /** The turn taking them: it holds their rows from now (see `Outstanding.foldedInto`). */
    adoptedBy: string,
  ): { rows: (number | undefined)[]; from: string[] } {
    const rows: (number | undefined)[] = [];
    const from: string[] = [];
    const outstanding = this.sessionStates.get(mind)?.get(session)?.outstanding;
    for (const [id, d] of outstanding ?? []) {
      if (d.process !== process || (ids ? !ids.includes(id) : d.retiring)) continue;
      rows.push(...d.rows);
      if (d.foldedInto) from.push(d.foldedInto);
      d.foldedInto = adoptedBy;
    }
    return { rows, from };
  }

  /** A POST the mind never took: its delivery is no longer outstanding. */
  private dropOutstanding(mind: string, session: string, deliveryId: string): void {
    // Deliberately does NOT free the concurrency slot. This runs on the failed-POST paths,
    // and a failed delivery that would have folded into a running turn does not end that
    // turn — releasing here would open the gate mid-turn. `sessionDone` frees the slot
    // instead, which is the one signal that actually means the turn is over.
    const mindSessions = this.sessionStates.get(mind);
    const state = mindSessions?.get(session);
    if (!mindSessions || !state) return;
    if (state.outstanding.delete(deliveryId) && state.outstanding.size === 0) {
      this.onIdle(mind, session, mindSessions);
    }
  }

  /** Retire the deliveries a `done` finished (see `sessionDone`). */
  private retire(mind: string, session: string, retired: string[] | undefined): void {
    const mindSessions = this.sessionStates.get(mind);
    const state = mindSessions?.get(session);
    if (!mindSessions || !state || state.outstanding.size === 0) return;
    for (const id of [...state.outstanding.keys()]) {
      if (!retired || retired.includes(id)) state.outstanding.delete(id);
    }
    if (state.outstanding.size === 0) this.onIdle(mind, session, mindSessions);
  }

  private onIdle(mind: string, session: string, mindSessions: Map<string, SessionState>): void {
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

// --- Singleton ---

let instance: DeliveryManager | undefined;

export function initDeliveryManager(): DeliveryManager {
  if (instance) throw new Error("DeliveryManager already initialized");
  instance = new DeliveryManager();
  return instance;
}

export function getDeliveryManager(): DeliveryManager {
  if (!instance) throw new ManagerNotReadyError("DeliveryManager", "initDeliveryManager");
  return instance;
}

/** Like getDeliveryManager but returns undefined instead of throwing when uninitialized. */
export function tryGetDeliveryManager(): DeliveryManager | undefined {
  return instance;
}
