import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { voluteSystemDir } from "../mind/registry.js";
import log from "../util/logger.js";

export interface BridgeConfig {
  enabled: boolean;
  defaultMind: string;
  channelMappings: Record<string, string>;
}

export type BridgesConfig = Record<string, BridgeConfig>;

function bridgesPath(): string {
  return resolve(voluteSystemDir(), "bridges.json");
}

export function readBridgesConfig(): BridgesConfig {
  const path = bridgesPath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    log.error(
      `bridges.json is corrupt or unreadable at ${path} — all bridges disabled`,
      log.errorData(err),
    );
    return {};
  }
}

export function writeBridgesConfig(config: BridgesConfig): void {
  writeFileSync(bridgesPath(), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

export function getBridgeConfig(platform: string): BridgeConfig | null {
  const config = readBridgesConfig();
  return config[platform] ?? null;
}

export function setBridgeConfig(platform: string, bridge: BridgeConfig): void {
  const config = readBridgesConfig();
  config[platform] = bridge;
  writeBridgesConfig(config);
}

export function removeBridgeConfig(platform: string): void {
  const config = readBridgesConfig();
  delete config[platform];
  writeBridgesConfig(config);
}

export function setChannelMapping(
  platform: string,
  externalChannel: string,
  voluteChannel: string,
): void {
  const config = readBridgesConfig();
  const bridge = config[platform];
  if (!bridge) throw new Error(`Bridge not configured for ${platform}`);
  bridge.channelMappings[externalChannel] = voluteChannel;
  writeBridgesConfig(config);
}

export function removeChannelMapping(platform: string, externalChannel: string): void {
  const config = readBridgesConfig();
  const bridge = config[platform];
  if (!bridge) return;
  delete bridge.channelMappings[externalChannel];
  writeBridgesConfig(config);
}

/**
 * Find the Volute channel name mapped to an external channel.
 */
export function resolveChannelMapping(platform: string, externalChannel: string): string | null {
  const bridge = getBridgeConfig(platform);
  if (!bridge) return null;
  return bridge.channelMappings[externalChannel] ?? null;
}

/**
 * Check if a conversation name is bridged to any platform.
 * Returns the platform and external channel if found.
 */
export function findBridgeForChannel(
  voluteChannelName: string,
): { platform: string; externalChannel: string } | null {
  const config = readBridgesConfig();
  for (const [platform, bridge] of Object.entries(config)) {
    if (!bridge.enabled) continue;
    for (const [external, volute] of Object.entries(bridge.channelMappings)) {
      if (volute === voluteChannelName) {
        return { platform, externalChannel: external };
      }
    }
  }
  return null;
}
