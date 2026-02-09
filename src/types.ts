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
  messageId?: string;
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

export const INTERACTIVE_CHANNELS = new Set(["web", "cli", "discord"]);
