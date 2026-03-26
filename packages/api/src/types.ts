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
  port: number;
  created: string;
  status: "running" | "stopped" | "starting" | "sleeping";
  stage?: "seed" | "sprouted";
  template?: string;
  channels: PlatformConnection[];
  hasPages?: boolean;
  lastActiveAt?: string | null;
  displayName?: string;
  description?: string;
  avatar?: string;
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
  channel: string;
  type: "dm" | "channel";
  user_id: number | null;
  private: number;
  created_at: string;
  updated_at: string;
};

export type Participant = {
  userId: number;
  username: string;
  userType: "brain" | "mind" | "puppet" | "system";
  role: "owner" | "member";
  displayName?: string | null;
  description?: string | null;
  avatar?: string | null;
};

export type Message = {
  id: number;
  conversation_id: string;
  role: "user" | "assistant";
  sender_name: string | null;
  content: ContentBlock[];
  created_at: string;
};

export type LastMessageSummary = {
  role: "user" | "assistant";
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

export type ActivityEventType =
  | "mind_started"
  | "mind_stopped"
  | "mind_active"
  | "mind_idle"
  | "mind_done"
  | "mind_sleeping"
  | "mind_waking"
  | "page_updated"
  | "page_published"
  | "page_removed"
  | "note_created"
  | "brain_online"
  | "brain_offline"
  | "profile_updated";

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
  user_type: "brain" | "mind" | "system";
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
    maxThinkingTokens: number | null;
    tokenBudget: number | null;
    tokenBudgetPeriodMinutes: number | null;
    compaction: { maxContextTokens?: number | null } | null;
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
  session: string | null;
  sender: string | null;
  message_id: string | null;
  type: string;
  content: string;
  metadata: string | null;
  turn_id: string | null;
  created_at: string;
};

export type HistorySession = {
  session: string;
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

export type TurnTrigger = {
  channel: string | null;
  sender: string | null;
  content: string | null;
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
  activities: TurnActivity[];
};

export type SummaryPeriod = "turn" | "hour" | "day" | "week" | "month";

export type SummaryRow = {
  id: number;
  mind: string;
  period: SummaryPeriod;
  period_key: string;
  content: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
};
