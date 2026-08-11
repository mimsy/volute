// Entity types shared between frontend and backend.
// Entity types use snake_case fields to match database columns.
// SSE event types in events.ts use camelCase because they're constructed in JS.

import type { AppType } from "@volute/daemon/web/app.js";
import type { hc, InferResponseType } from "hono/client";
import type { UserType } from "./user-type.js";

// --- Server-derived response types (RPC-first) ---------------------------------
// A phantom typed client, evaluated only in type space (never constructed at
// runtime), lets us index AppType's route tree and read each endpoint's inferred
// JSON response shape. This is the single source of truth: a server change that
// alters a response body surfaces here as a compile error instead of a runtime
// surprise. See #333.
type Client = ReturnType<typeof hc<AppType>>;
type V1 = Client["api"]["v1"];

/** The JSON body a route returns on success (HTTP 200). */
type Ok<T> = InferResponseType<T, 200>;
/** Element type of an array response. */
type Elem<T> = T extends readonly (infer U)[] ? U : never;

type _MindWire = Elem<Ok<V1["minds"]["$get"]>>;

// --- Kept hand-written (not derived), by category -------------------------------
// These are deliberate, not derivation oversights. Two reasons a type stays here:
//   (a) api-owned: the daemon imports the type from @volute/api to annotate the
//       very handler that returns it, so InferResponseType would resolve straight
//       back to this alias — a circular self-reference. The type IS the source of
//       truth; the server borrows it. (ContentBlock, Conversation, Message,
//       LastMessageSummary, ConversationWithParticipants, Participant,
//       ParticipantProfile, the Feed* family, ChannelContext.)
//   (b) not a single /api/v1 response shape: shared vocabulary the web also
//       constructs (ActivityEventType, ActivityItem, SummaryPeriod, VoluteEvent),
//       or a shape served by an extension route that AppType doesn't cover
//       (RecentPage, Site, SitePage).
// TurnRow and SummaryRow are a third, temporary case — derivable in principle but
// blocked today; see the note above their definitions.

// kept (a): daemon annotates message/tool payloads with this
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; name: string; input: unknown }
  | { type: "tool_result"; output: string; is_error?: boolean }
  | { type: "image"; media_type: string; data: string };

// The web dashboard and CLI authenticate as privileged principals (admin user or
// system spirit), so they receive the full mind shape. GET /minds returns a union
// of that privileged shape and a reduced public shape (mind-token callers, #503);
// we select the privileged branch by its `port` discriminant. Still fully
// server-derived — no hand-invented fields — so a server change to the shape is a
// compile error here.
export type Mind = Extract<_MindWire, { port: number }>;

// Sub-shapes of the mind payload, extracted from the derived Mind so they track
// the server and stay usable on their own. Doc comments describe intent; the
// shapes are the server's.

/**
 * The cost of a mind's always-loaded MEMORY.md, estimated as bytes/4 tokens.
 * Over `softBudgetTokens` a consolidation nudge is warranted; over `hardCapTokens`
 * the mind's template loads only the head of the file.
 */
export type MindMemoryStatus = NonNullable<Mind["memory"]>;

/** The seed → sprout checklist, as surfaced in a seed's status payload. */
export type SeedChecklist = NonNullable<Mind["seedChecklist"]>;

/**
 * The mind's most recent unrecovered failure. `detail` is admin/system only —
 * unknown-reason details embed the raw error string, which is mind-private
 * (served behind requireSelf), so the public payload omits it.
 */
export type MindLastError = NonNullable<Mind["lastError"]>;

export type PlatformConnection = Mind["channels"][number];

// kept (a): daemon's conversations lib returns/annotates rows with this
export type Conversation = {
  id: string;
  type: "dm" | "channel";
  user_id: number | null;
  private: number;
  created_at: string;
  updated_at: string;
};

// kept (a): daemon's getParticipants() is annotated Promise<Participant[]>
export type Participant = {
  userId: number;
  username: string;
  userType: UserType;
  role: "owner" | "member";
  displayName?: string | null;
  description?: string | null;
  avatar?: string | null;
};

// kept (a): daemon's getMessagesPaginated() is annotated with Message
export type Message = {
  id: number;
  conversation_id: string;
  // "event" marks a sender-less automated announcement (e.g. #system "X has joined"), which
  // the UI renders as an event rather than a chat message attributed to a sender (#687).
  role: "user" | "assistant" | "event";
  sender_name: string | null;
  content: ContentBlock[];
  created_at: string;
};

// kept (a): sub-shape of ConversationWithParticipants, which the daemon annotates
export type LastMessageSummary = {
  role: "user" | "assistant" | "event";
  senderName: string | null;
  text: string;
  createdAt: string;
};

// kept (a): daemon's listConversationsWithParticipants() is annotated with this
export type ConversationWithParticipants = Conversation & {
  channel_name: string | null;
  participants: Participant[];
  lastMessage?: LastMessageSummary;
  unreadCount?: number;
};

// kept (b): shared vocabulary — appears in the SSE `activity` stream (events.ts,
// constructed in JS) as well as GET /history/activity, and its `metadata` hits the
// same JSONValue transform noted on TurnRow/SummaryRow.
export type ActivityItem = {
  id: number;
  type: ActivityEventType;
  mind: string;
  summary: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
};

// kept (a): the Feed* family is imported by the daemon's feed.ts to build /feed
/** One snippet line shown on a chat-event card. */
export type FeedSnippetMessage = {
  role: "user" | "assistant";
  senderName: string | null;
  text: string;
  createdAt: string;
};

/** A burst of conversation activity, derived at read time from the messages table. */
export type FeedChatEvent = {
  kind: "chat";
  conversationId: string;
  conversationType: "dm" | "channel";
  channelName: string | null;
  participants: Participant[];
  /** Distinct sender names that spoke in this burst. */
  activeSenders: string[];
  messageCount: number;
  startedAt: string;
  endedAt: string;
  /** The last few messages of the burst, for a preview. */
  snippet: FeedSnippetMessage[];
};

/** A lifecycle moment (started/stopped/sleeping/waking/error/backup) in the feed. */
export type FeedLifecycleEvent = {
  kind: "lifecycle";
  id: number;
  type: ActivityEventType;
  mind: string;
  summary: string;
  createdAt: string;
};

export type FeedEvent = FeedChatEvent | FeedLifecycleEvent;

export type FeedResponse = { events: FeedEvent[] };

/** The AI daily digest header. Empty content means "nothing to show" (frontend hides it). */
export type FeedDigest = { content: string };

// kept (b): shared enum vocabulary (used by ActivityItem, Feed*, and SSE events)
export type ActivityEventType =
  | "mind_started"
  | "mind_stopped"
  | "mind_active"
  | "mind_idle"
  | "mind_done"
  | "mind_error"
  | "mind_sleeping"
  | "mind_waking"
  | "mind_sprouted"
  | "page_updated"
  | "page_published"
  | "page_removed"
  | "note_created"
  | "brain_online"
  | "brain_offline"
  | "profile_updated"
  | "backup_failed";

// GET /minds/:name/variants — the server spreads the full registry entry plus a
// computed `status`, so the derived type is a superset of the fields the old
// hand-written shape named. Server is the source of truth.
export type Variant = Elem<Ok<V1["minds"][":name"]["variants"]["$get"]>>;

// kept (b): served by the Pages extension's routes (/api/ext/pages/*), which the
// core AppType doesn't cover — not derivable from it.
export type RecentPage = {
  mind: string;
  file: string;
  modified: string;
  url: string;
};

export type SitePage = { file: string; modified: string; url: string };
export type Site = { name: string; label: string; pages: SitePage[] };

// kept (b): the mind server's stream envelope (server-sent while a turn runs), not
// a daemon /api/v1 JSON response.
export type VoluteEvent =
  | { type: "meta"; conversationId: string; senderName?: string }
  | { type: "done" };

// kept (b): request/transport helper shape, not tied to one /api/v1 response.
export type FileContent = {
  filename: string;
  content: string;
};

// GET /auth/users
export type AvailableUser = Elem<Ok<V1["auth"]["users"]["$get"]>>;

// kept (a): projection of Participant; the daemon imports it to annotate delivery
export type ParticipantProfile = Pick<
  Participant,
  "username" | "userType" | "displayName" | "description"
>;

// GET /prompts
export type Prompt = Elem<Ok<V1["prompts"]["$get"]>>;

// GET /skills
export type SharedSkill = Elem<Ok<V1["skills"]["$get"]>>;

// GET /minds/:name/skills
export type MindSkillInfo = Elem<Ok<V1["minds"][":name"]["skills"]["$get"]>>;

// POST /minds/:name/skills/update
export type UpdateResult = Ok<V1["minds"][":name"]["skills"]["update"]["$post"]>;

// GET /minds/:name/config
export type MindConfig = Ok<V1["minds"][":name"]["config"]["$get"]>;

// GET /minds/:name/env
export type MindEnv = Ok<V1["minds"][":name"]["env"]["$get"]>;

// GET /channels/:name — the `settings` field is the server's canonical channel
// settings (charLimit is channel-wide: at most `rateLimit` messages per
// `rateWindow` seconds, all senders pooled).
export type ChannelSettings = NonNullable<Ok<V1["channels"][":name"]["$get"]>["settings"]>;

/**
 * What a channel tells a mind about itself — delivered once per channel per session,
 * alongside the participant profiles. Its own privacy isn't part of the introduction.
 * Kept hand-written (as a projection of ChannelSettings): the daemon imports this to
 * annotate delivery, so it's an input to the server, not a response shape to derive.
 */
export type ChannelContext = Omit<ChannelSettings, "private">;

// GET /channels
export type ChannelInfo = Elem<Ok<V1["channels"]["$get"]>>;

// GET /minds/:name/history
export type HistoryMessage = Elem<Ok<V1["minds"][":name"]["history"]["$get"]>>;

// GET /minds/:name/history/sessions
export type HistorySession = Elem<Ok<V1["minds"][":name"]["history"]["sessions"]["$get"]>>;

// NOTE (#333): TurnRow and SummaryRow are the two response shapes that resisted
// clean derivation from AppType, so they stay hand-written for now. Two concrete
// blockers, both worth fixing in a follow-up:
//  1. Hono's InferResponseType models the JSON round-trip, so a handler's
//     `Record<string, unknown>` metadata comes back as `{ [x: string]: JSONValue }`
//     and ContentBlock's `input: unknown` widens the block `type` literal. That
//     clashes with the view-model helpers (timeline-card, RailIcons) typed on
//     `Record<string, unknown>` / `ContentBlock` — a real impedance mismatch that
//     needs those helpers re-typed, not a shim.
//  2. GET /history/summaries returns a two-branch union (fetch-by-ids vs
//     fetch-by-period); the union hides the period-only `icons` field, so
//     `SummaryRow["icons"]` and every `row.icons` read stops compiling.
// Deriving them anyway produced a 14-site cascade (JSONValue mismatches +
// implicit-any) beyond this types-only PR. Reported, not silently kept.

export type TurnConversation = {
  id: string;
  label: string;
  type: "dm" | "channel";
  messages: {
    id: number;
    role: "user" | "assistant";
    sender_name: string | null;
    content: ContentBlock[];
    source_event_id: number | null;
    created_at: string;
  }[];
};

export type TurnActivity = {
  id: number;
  type: ActivityEventType;
  summary: string;
  metadata: Record<string, unknown> | null;
  source_event_id: number | null;
  created_at: string;
};

/**
 * A system event delivered to the mind during a turn. Not a message: it has no sender and
 * no channel to reply to, so it is kept out of `conversations` entirely and rendered as a
 * system marker.
 */
export type TurnSystemEvent = {
  id: number;
  label: string;
  content: string | null;
  created_at: string | null;
};

export type TurnTrigger = {
  /** mind_history row id of the trigger — matches events[].id / messages[].source_event_id. */
  eventId: number;
  channel: string | null;
  sender: string | null;
  content: string | null;
  /** Set when the turn was triggered by a system event rather than by a message. */
  event?: { type: string; label: string };
};

export type TurnRow = {
  id: string;
  mind: string;
  summary: string | null;
  summary_meta: Record<string, unknown> | null;
  status: "active" | "complete";
  created_at: string;
  trigger: TurnTrigger | null;
  conversations: TurnConversation[];
  events: TurnSystemEvent[];
  activities: TurnActivity[];
};

/** The rollup periods a summary can cover — query-param vocabulary shared with the server. */
export type SummaryPeriod = "turn" | "hour" | "day" | "week" | "month";

/** Grouped per-period icon data, present when summaries are fetched with `include=icons`. */
export type SummaryIcons = {
  conversations: { id: string; label: string; type: "dm" | "channel"; count: number }[];
  events: { label: string; count: number }[];
  activities: {
    type: string;
    count: number;
    icon?: string;
    color?: string;
    items: {
      id: number;
      summary: string;
      metadata: Record<string, unknown> | null;
      created_at: string | null;
    }[];
  }[];
};

export type SummaryRow = {
  id: number;
  mind: string;
  period: SummaryPeriod;
  period_key: string;
  content: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
  icons?: SummaryIcons;
};
