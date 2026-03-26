import * as discord from "./platforms/discord.js";
import * as slack from "./platforms/slack.js";
import * as telegram from "./platforms/telegram.js";
import * as volute from "./platforms/volute.js";

export type PlatformConversation = {
  id: string;
  platformId: string;
  name: string;
  type: "dm" | "channel";
  participantCount?: number;
};

export type PlatformUser = {
  id: string;
  username: string;
  type?: string;
};

export type ImageAttachment = {
  media_type: string;
  data: string; // base64
};

export type PlatformDriver = {
  read(env: Record<string, string>, channelId: string, limit: number): Promise<string>;
  send(
    env: Record<string, string>,
    channelId: string,
    message: string,
    images?: ImageAttachment[],
  ): Promise<void>;
  listConversations?(env: Record<string, string>): Promise<PlatformConversation[]>;
  listUsers?(env: Record<string, string>): Promise<PlatformUser[]>;
  createConversation?(
    env: Record<string, string>,
    participants: string[],
    name?: string,
  ): Promise<string>;
};

export type Platform = {
  name: string;
  displayName: string;
  builtIn?: boolean;
  driver?: PlatformDriver;
};

export const PLATFORMS: Record<string, Platform> = {
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

export function getPlatform(channelUri?: string): Platform {
  if (!channelUri) return PLATFORMS.volute;
  if (!channelUri.includes(":")) return PLATFORMS.volute;
  const platform = channelUri.split(":")[0];
  return (
    PLATFORMS[platform] ?? {
      name: platform,
      displayName: platform,
    }
  );
}

export function getPlatformDriver(platform: string): PlatformDriver | null {
  return PLATFORMS[platform]?.driver ?? null;
}

/** Resolve a channel slug to its platform ID.
 *  Returns the part after the colon, or the full string if no colon. */
export function resolvePlatformId(slug: string): string {
  const colonIdx = slug.indexOf(":");
  return colonIdx !== -1 ? slug.slice(colonIdx + 1) : slug;
}
