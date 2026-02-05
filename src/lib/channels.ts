export type ChannelConfig = {
  name: string;
  displayName: string;
  showToolCalls: boolean;
};

export const CHANNELS: Record<string, ChannelConfig> = {
  web: { name: "web", displayName: "Web UI", showToolCalls: true },
  discord: { name: "discord", displayName: "Discord", showToolCalls: false },
};

export function getChannelConfig(channelUri?: string): ChannelConfig {
  if (!channelUri) return CHANNELS.web;
  const platform = channelUri.split(":")[0];
  return CHANNELS[platform] ?? CHANNELS.web;
}
