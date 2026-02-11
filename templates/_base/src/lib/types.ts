export type VoluteContentPart =
  | { type: "text"; text: string }
  | { type: "image"; media_type: string; data: string };

export type ChannelMeta = {
  channel?: string;
  sender?: string;
  platform?: string;
  isDM?: boolean;
  channelName?: string;
  guildName?: string;
  sessionName?: string;
  participants?: string[];
  participantCount?: number;
};

/** ChannelMeta enriched by the router with dispatch info. */
export type HandlerMeta = ChannelMeta & {
  messageId: string;
  interrupt?: boolean;
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
  | { type: "done" }
);

export type Listener = (event: VoluteEvent) => void;

/** A handler that processes a single routed message and streams events to a listener. */
export type MessageHandler = {
  handle(content: VoluteContentPart[], meta: HandlerMeta, listener: Listener): () => void; // returns unsubscribe
};

/** Resolves a key (session name, file path, etc.) to a MessageHandler. */
export type HandlerResolver = (key: string) => MessageHandler;
