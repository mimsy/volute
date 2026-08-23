export type VoluteContentPart =
  | { type: "text"; text: string }
  | { type: "image"; media_type: string; data: string };

export type ParticipantProfile = {
  username: string;
  userType: "human" | "mind";
  displayName?: string | null;
  description?: string | null;
};

/** What a channel says about itself: what it's for, its rules, and the limits it enforces. */
export type ChannelInfo = {
  description?: string | null;
  rules?: string | null;
  charLimit?: number | null;
  rateLimit?: number | null;
  rateWindow?: number | null;
};

export type ChannelMeta = {
  channel?: string;
  sender?: string;
  platform?: string;
  isDM?: boolean;
  /** True when this turn was triggered by a system event (not a person). */
  isEvent?: boolean;
  /** Worded label for an event, e.g. "Schedule: morning-check". */
  eventLabel?: string;
  /** The event's timestamp (UTC) for the envelope prefix. */
  eventAt?: string;
  channelName?: string;
  serverName?: string;
  sessionName?: string;
  participants?: string[];
  participantCount?: number;
  participantProfiles?: ParticipantProfile[];
  /** The channel's own description, rules, and limits — sent once per channel per session. */
  channelInfo?: ChannelInfo;
  typing?: string[];
  replyInstructions?: "once" | "always" | "never";
  interrupt?: boolean;
  signature?: string;
  signatureTimestamp?: string;
  signerFingerprint?: string;
  verified?: boolean;
};

/** ChannelMeta enriched by the router with dispatch info. */
export type HandlerMeta = ChannelMeta & {
  messageId: string;
};

export type VoluteRequest = {
  content: VoluteContentPart[];
  session?: string;
} & ChannelMeta;

/**
 * One model's slice of a turn's usage. A turn can span models — a main call plus a
 * cheaper side-call or a subagent — and their rates differ by up to 5x, so the slices
 * are carried separately and priced separately rather than attributed to one model.
 */
export type UsageByModel = {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
};

export type VoluteEvent = { messageId?: string } & (
  | { type: "text"; content: string }
  | { type: "image"; media_type: string; data: string }
  | { type: "tool_use"; name: string; input: unknown }
  | { type: "tool_result"; output: string; is_error?: boolean }
  | {
      type: "usage";
      /**
       * Uncached input tokens only — cache reads/writes are reported separately so the
       * daemon can price each at its own rate. Templates that receive a cache-inclusive
       * input count (codex) subtract the cached portion before emitting.
       */
      input_tokens: number;
      output_tokens: number;
      /** Absent (not zero) from templates that predate cache accounting — see `partial` in usage-pricing.ts. */
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
      /**
       * The model that did most of the turn's work; `provider:id` when the template knows
       * the provider (pi), else a bare id. A label — `models` is what gets priced.
       */
      model?: string;
      /**
       * Per-model breakdown, when the agent reports one. The daemon prices each slice at
       * its own model's rates and sums, so a turn spanning two models costs what it
       * actually cost. Absent means the whole turn is priced against `model`.
       */
      models?: UsageByModel[];
    }
  | { type: "done" }
);

export type Listener = (event: VoluteEvent) => void;

/** A handler that processes a single routed message and emits events to an optional listener callback. */
export type MessageHandler = {
  handle(content: VoluteContentPart[], meta: HandlerMeta, listener?: Listener): () => void; // returns unsubscribe
};

/** Resolves a key (session name, file path, etc.) to a MessageHandler. */
export type HandlerResolver = (key: string) => MessageHandler;
