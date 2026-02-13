import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { VoluteEvent } from "../types.js";
import * as discord from "./channels/discord.js";
import * as slack from "./channels/slack.js";
import * as telegram from "./channels/telegram.js";
import * as volute from "./channels/volute.js";

export type ChannelConversation = {
  id: string;
  platformId: string;
  name: string;
  type: "dm" | "group" | "channel";
  participantCount?: number;
};

export type ChannelUser = {
  id: string;
  username: string;
  type?: string;
};

export type ChannelDriver = {
  read(env: Record<string, string>, channelId: string, limit: number): Promise<string>;
  send(env: Record<string, string>, channelId: string, message: string): Promise<void>;
  sendAndStream?(
    env: Record<string, string>,
    channelId: string,
    message: string,
  ): AsyncIterable<VoluteEvent>;
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
  showToolCalls: boolean;
  builtIn?: boolean;
  driver?: ChannelDriver;
};

export const CHANNELS: Record<string, ChannelProvider> = {
  volute: {
    name: "volute",
    displayName: "Volute",
    showToolCalls: true,
    builtIn: true,
    driver: volute,
  },
  discord: {
    name: "discord",
    displayName: "Discord",
    showToolCalls: false,
    driver: discord,
  },
  slack: {
    name: "slack",
    displayName: "Slack",
    showToolCalls: false,
    driver: slack,
  },
  telegram: {
    name: "telegram",
    displayName: "Telegram",
    showToolCalls: false,
    driver: telegram,
  },
  system: { name: "system", displayName: "System", showToolCalls: false },
};

export function getChannelProvider(channelUri?: string): ChannelProvider {
  if (!channelUri) return CHANNELS.volute;
  const platform = channelUri.split(":")[0];
  return (
    CHANNELS[platform] ?? {
      name: platform,
      displayName: platform,
      showToolCalls: false,
    }
  );
}

export function getChannelDriver(platform: string): ChannelDriver | null {
  return CHANNELS[platform]?.driver ?? null;
}

/** Resolve a channel slug (e.g. "discord:my-server/general") to its platform ID via channels.json.
 *  Falls back to the slug suffix (part after colon) if not found. */
export function resolveChannelId(env: Record<string, string>, slug: string): string {
  const agentDir = env.VOLUTE_AGENT_DIR;
  if (!agentDir) {
    const colonIdx = slug.indexOf(":");
    return colonIdx !== -1 ? slug.slice(colonIdx + 1) : slug;
  }
  const mapPath = resolve(agentDir, ".volute", "channels.json");
  if (!existsSync(mapPath)) {
    const colonIdx = slug.indexOf(":");
    return colonIdx !== -1 ? slug.slice(colonIdx + 1) : slug;
  }
  try {
    const map = JSON.parse(readFileSync(mapPath, "utf-8"));
    const entry = map[slug];
    if (entry?.platformId) return entry.platformId;
  } catch {}
  const colonIdx = slug.indexOf(":");
  return colonIdx !== -1 ? slug.slice(colonIdx + 1) : slug;
}
