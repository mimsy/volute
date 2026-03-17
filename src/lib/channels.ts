import * as discord from "./channels/discord.js";
import * as slack from "./channels/slack.js";
import * as telegram from "./channels/telegram.js";
import * as volute from "./channels/volute.js";

export type ChannelConversation = {
  id: string;
  platformId: string;
  name: string;
  type: "dm" | "channel";
  participantCount?: number;
};

export type ChannelUser = {
  id: string;
  username: string;
  type?: string;
};

export type ImageAttachment = {
  media_type: string;
  data: string; // base64
};

export type ChannelDriver = {
  read(env: Record<string, string>, channelId: string, limit: number): Promise<string>;
  send(
    env: Record<string, string>,
    channelId: string,
    message: string,
    images?: ImageAttachment[],
  ): Promise<void>;
  listConversations?(env: Record<string, string>): Promise<ChannelConversation[]>;
  listUsers?(env: Record<string, string>): Promise<ChannelUser[]>;
  createConversation?(
    env: Record<string, string>,
    participants: string[],
    name?: string,
  ): Promise<string>;
};

export type ChannelProvider = {
  name: string;
  displayName: string;
  builtIn?: boolean;
  driver?: ChannelDriver;
};

export const CHANNELS: Record<string, ChannelProvider> = {
  volute: {
    name: "volute",
    displayName: "Volute",
    builtIn: true,
    driver: volute,
  },
  discord: {
    name: "discord",
    displayName: "Discord",
    driver: discord,
  },
  slack: {
    name: "slack",
    displayName: "Slack",
    driver: slack,
  },
  telegram: {
    name: "telegram",
    displayName: "Telegram",
    driver: telegram,
  },
  mail: { name: "mail", displayName: "Email" },
  system: { name: "system", displayName: "System" },
};

export function getChannelProvider(channelUri?: string): ChannelProvider {
  if (!channelUri) return CHANNELS.volute;
  if (!channelUri.includes(":")) return CHANNELS.volute;
  const platform = channelUri.split(":")[0];
  return (
    CHANNELS[platform] ?? {
      name: platform,
      displayName: platform,
    }
  );
}

export function getChannelDriver(platform: string): ChannelDriver | null {
  return CHANNELS[platform]?.driver ?? null;
}

/** Resolve a channel slug to its platform ID.
 *  Returns the part after the colon, or the full string if no colon. */
export function resolveChannelId(_env: Record<string, string>, slug: string): string {
  const colonIdx = slug.indexOf(":");
  return colonIdx !== -1 ? slug.slice(colonIdx + 1) : slug;
}
