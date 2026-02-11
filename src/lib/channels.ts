import * as discord from "./channels/discord.js";
import * as slack from "./channels/slack.js";
import * as telegram from "./channels/telegram.js";
import * as volute from "./channels/volute.js";

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
  volute: { name: "volute", displayName: "Volute", showToolCalls: true, driver: volute },
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
