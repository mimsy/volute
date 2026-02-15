export type VoluteContentPart =
  | { type: "text"; text: string }
  | { type: "image"; media_type: string; data: string };

export type ChannelMeta = {
  channel?: string;
  sender?: string;
  platform?: string;
  isDM?: boolean;
  channelName?: string;
  serverName?: string;
  sessionName?: string;
  participants?: string[];
  participantCount?: number;
  typing?: string[];
};

/** ChannelMeta enriched by the router with dispatch info. */
export type HandlerMeta = ChannelMeta & {
  messageId: string;
  interrupt?: boolean;
  autoReply: boolean;
};

export type VoluteRequest = {
  content: VoluteContentPart[];
  session?: string;
} & ChannelMeta;

export type VoluteEvent = { messageId?: string } & (
  | { type: "text"; content: string }
  | { type: "image"; media_type: string; data: string }
  | { type: "tool_use"; name: string; input: unknown }
  | { type: "tool_result"; output: string; is_error?: boolean }
  | { type: "usage"; input_tokens: number; output_tokens: number }
  | { type: "done" }
);

export type Listener = (event: VoluteEvent) => void;

/** A handler that processes a single routed message and emits events to a listener callback. */
export type MessageHandler = {
  handle(content: VoluteContentPart[], meta: HandlerMeta, listener: Listener): () => void; // returns unsubscribe
};

/** Resolves a key (session name, file path, etc.) to a MessageHandler. */
export type HandlerResolver = (key: string) => MessageHandler;
