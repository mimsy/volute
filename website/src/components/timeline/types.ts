// Mirrors packages/api/src/types.ts — the shapes the timeline components expect.

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; name: string; input: unknown }
  | { type: "tool_result"; output: string; is_error?: boolean }
  | { type: "image"; media_type: string; data: string };

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
  type: string;
  summary: string;
  metadata: Record<string, unknown> | null;
  source_event_id: number | null;
  created_at: string;
};

export type TurnTrigger = {
  channel: string | null;
  sender: string | null;
  content: string | null;
  /** Set when the turn was triggered by a system event rather than by a message. */
  event?: { type: string; label: string };
};

export type TurnSystemEvent = {
  id: number;
  label: string;
  content: string | null;
  created_at: string | null;
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

export type SummaryRow = {
  id: number;
  mind: string;
  period: SummaryPeriod;
  period_key: string;
  content: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
};

export type TimelineItem =
  | { kind: "turn"; turn: TurnRow }
  | { kind: "summary"; summary: SummaryRow }
  | { kind: "separator"; above: string; below: string };
