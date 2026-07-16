// Entity types shared between frontend and backend.
// Entity types use snake_case fields to match database columns.
// SSE event types in events.ts use camelCase because they're constructed in JS.

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; name: string; input: unknown }
  | { type: "tool_result"; output: string; is_error?: boolean }
  | { type: "image"; media_type: string; data: string };

export type Mind = {
  name: string;
  // Omitted for non-privileged callers (mind tokens, non-admin users); only
  // admin/system get the port. See #503.
  port?: number;
  created: string;
  status: "running" | "stopped" | "starting" | "sleeping";
  /** When status is "sleeping": ISO time of the scheduled wake, if one is set. */
  wakeAt?: string | null;
  /** Most recent failure the mind hasn't recovered from (cleared on the next clean turn). */
  lastError?: MindLastError | null;
  stage?: "seed" | "sprouted";
  template?: string;
  channels: PlatformConnection[];
  hasPages?: boolean;
  templateStale?: boolean;
  lastActiveAt?: string | null;
  displayName?: string;
  description?: string;
  avatar?: string;
  mindType?: "mind" | "spirit";
  /** Sprout-checklist state — present only for seed-stage minds. */
  seedChecklist?: SeedChecklist;
};

/** The seed → sprout checklist, as surfaced in a seed's status payload. */
export type SeedChecklist = {
  soulWritten: boolean;
  memoryWritten: boolean;
  displayNameSet: boolean;
  avatarSet: boolean;
  imagegenEnabled: boolean;
};

export type MindLastError = {
  kind: "turn_error" | "crash" | "startup";
  reason: string;
  /**
   * Full failure detail. Admin/system callers only — omitted for non-privileged
   * callers because unknown-reason details embed the raw error string, which is
   * otherwise mind-private (served behind requireSelf).
   */
  detail?: string;
  at: string;
};

export type PlatformConnection = {
  name: string;
  displayName: string;
  status: "connected" | "disconnected";
  username?: string;
  connectedAt?: string;
};

export type Conversation = {
  id: string;
  type: "dm" | "channel";
  user_id: number | null;
  private: number;
  created_at: string;
  updated_at: string;
};

export type Participant = {
  userId: number;
  username: string;
  userType: "human" | "mind" | "puppet" | "system";
  role: "owner" | "member";
  displayName?: string | null;
  description?: string | null;
  avatar?: string | null;
};

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

export type LastMessageSummary = {
  role: "user" | "assistant" | "event";
  senderName: string | null;
  text: string;
  createdAt: string;
};

export type ConversationWithParticipants = Conversation & {
  channel_name: string | null;
  participants: Participant[];
  lastMessage?: LastMessageSummary;
  unreadCount?: number;
};

export type ActivityItem = {
  id: number;
  type: ActivityEventType;
  mind: string;
  summary: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
};

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

export type Variant = {
  name: string;
  branch: string;
  path: string;
  port: number;
  created: string;
  status: "running" | "dead" | "no-server";
};

export type RecentPage = {
  mind: string;
  file: string;
  modified: string;
  url: string;
};

export type SitePage = { file: string; modified: string; url: string };
export type Site = { name: string; label: string; pages: SitePage[] };

export type VoluteEvent =
  | { type: "meta"; conversationId: string; senderName?: string }
  | { type: "done" };

export type FileContent = {
  filename: string;
  content: string;
};

export type AvailableUser = {
  id: number;
  username: string;
  role: "admin" | "user" | "pending" | "mind" | "system";
  user_type: "human" | "mind" | "system";
  display_name?: string | null;
  description?: string | null;
  avatar?: string | null;
};

export type ParticipantProfile = Pick<
  Participant,
  "username" | "userType" | "displayName" | "description"
>;

export type Prompt = {
  key: string;
  content: string;
  description: string;
  variables: string[];
  isCustom: boolean;
  category: "creation" | "system" | "mind";
};

export type SharedSkill = {
  id: string;
  name: string;
  description: string;
  author: string;
  version: number;
  created_at: string;
  updated_at: string;
};

export type MindSkillInfo = {
  id: string;
  name: string;
  description: string;
  upstream: { source: string; version: number; baseCommit: string } | null;
  updateAvailable: boolean;
};

export type UpdateResult =
  | { status: "updated" }
  | { status: "up-to-date" }
  | { status: "conflict"; conflictFiles: string[] };

export type MindConfig = {
  registry: {
    name: string;
    port: number;
    created: string;
    stage?: string;
    template?: string;
  };
  config: {
    model: string | null;
    thinkingLevel: string | null;
    tokenBudget: number | null;
    tokenBudgetPeriodMinutes: number | null;
    compaction: { maxContextTokens?: number | null } | null;
    unescapeNewlines: boolean;
  };
};

export type MindEnv = {
  shared: Record<string, string>;
  mind: Record<string, string>;
};

export type ChannelSettings = {
  description: string | null;
  rules: string | null;
  charLimit: number | null;
  private: boolean;
};

export type ChannelInfo = Conversation & {
  channel_name: string;
  participantCount: number;
  isMember: boolean;
  settings?: ChannelSettings;
};

export type HistoryMessage = {
  id: number;
  mind: string;
  channel: string;
  thread: string | null;
  sender: string | null;
  message_id: string | null;
  type: string;
  content: string;
  metadata: string | null;
  turn_id: string | null;
  created_at: string;
};

export type HistorySession = {
  thread: string;
  started_at: string;
  event_count: number;
  message_count: number;
  tool_count: number;
};

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
