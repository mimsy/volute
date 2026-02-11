import * as discord from "./channels/discord.js";
import * as slack from "./channels/slack.js";
import * as telegram from "./channels/telegram.js";

export type ChannelDriver = {
  read(env: Record<string, string>, channelId: string, limit: number): Promise<string>;
  send(env: Record<string, string>, channelId: string, message: string): Promise<void>;
};

export type ChannelProvider = {
  name: string;
  displayName: string;
  showToolCalls: boolean;
  driver?: ChannelDriver;
};

export const CHANNELS: Record<string, ChannelProvider> = {
  volute: { name: "volute", displayName: "Volute", showToolCalls: true },
  web: { name: "web", displayName: "Web UI", showToolCalls: true },
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
  cli: { name: "cli", displayName: "CLI", showToolCalls: true },
  agent: { name: "agent", displayName: "Agent", showToolCalls: true },
  system: { name: "system", displayName: "System", showToolCalls: false },
};

export function getChannelProvider(channelUri?: string): ChannelProvider {
  if (!channelUri) return CHANNELS.web;
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
