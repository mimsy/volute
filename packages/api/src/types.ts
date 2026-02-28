// Entity types shared between frontend and backend

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
  channels: Channel[];
  hasPages?: boolean;
  lastActiveAt?: string | null;
  displayName?: string;
  description?: string;
  avatar?: string;
};

export type Channel = {
  name: string;
  displayName: string;
  status: "connected" | "disconnected";
  showToolCalls: boolean;
  username?: string;
  connectedAt?: string;
};

export type Conversation = {
  id: string;
  mind_name: string | null;
  channel: string;
  type: "dm" | "group" | "channel";
  name: string | null;
  user_id: number | null;
  title: string | null;
  created_at: string;
  updated_at: string;
};

export type Participant = {
  userId: number;
  username: string;
  userType: string;
  role: string;
};

export type Message = {
  id: number;
  conversation_id: string;
  role: string;
  sender_name: string | null;
  content: ContentBlock[];
  created_at: string;
};

export type LastMessageSummary = {
  role: string;
  senderName: string | null;
  text: string;
  createdAt: string;
};

export type ConversationWithParticipants = Conversation & {
  participants: Participant[];
  lastMessage?: LastMessageSummary;
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
  | "page_updated";

export type Variant = {
  name: string;
  branch: string;
  path: string;
  port: number;
  created: string;
  status: string;
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
  role: string;
  user_type: string;
};

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
  };
};

export type MindEnv = {
  shared: Record<string, string>;
  mind: Record<string, string>;
};

export type ChannelInfo = Conversation & { participantCount: number; isMember: boolean };

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
  created_at: string;
};

export type HistorySession = {
  session: string;
  started_at: string;
  event_count: number;
  message_count: number;
  tool_count: number;
};
