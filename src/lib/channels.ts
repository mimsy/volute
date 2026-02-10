import * as discord from "./channels/discord.js";

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
  web: { name: "web", displayName: "Web UI", showToolCalls: true },
  discord: {
    name: "discord",
    displayName: "Discord",
    showToolCalls: false,
    driver: { read: discord.read, send: discord.send },
  },
  cli: { name: "cli", displayName: "CLI", showToolCalls: true },
  agent: { name: "agent", displayName: "Agent", showToolCalls: true },
  system: { name: "system", displayName: "System", showToolCalls: false },
};

export function getChannelConfig(channelUri?: string): ChannelProvider {
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
