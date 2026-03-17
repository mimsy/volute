import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export type BridgeEnvVar = {
  name: string;
  required: boolean;
  description: string;
};

export type BridgeDef = {
  displayName: string;
  description: string;
  envVars: BridgeEnvVar[];
};

const BUILTIN_DEFS: Record<string, BridgeDef> = {
  discord: {
    displayName: "Discord",
    description: "Bridge Discord channels and DMs to Volute conversations",
    envVars: [
      {
        name: "DISCORD_TOKEN",
        required: true,
        description: "Discord bot token",
      },
    ],
  },
  slack: {
    displayName: "Slack",
    description: "Bridge Slack channels and DMs to Volute conversations",
    envVars: [
      {
        name: "SLACK_BOT_TOKEN",
        required: true,
        description: "Slack bot token (xoxb-...)",
      },
      {
        name: "SLACK_APP_TOKEN",
        required: true,
        description: "Slack app-level token (xapp-...) for Socket Mode",
      },
    ],
  },
  telegram: {
    displayName: "Telegram",
    description: "Bridge Telegram chats and DMs to Volute conversations",
    envVars: [
      {
        name: "TELEGRAM_BOT_TOKEN",
        required: true,
        description: "Telegram bot token from BotFather",
      },
    ],
  },
};

export function getBridgeDef(type: string, bridgeDir?: string): BridgeDef | null {
  if (BUILTIN_DEFS[type]) return BUILTIN_DEFS[type];

  if (bridgeDir) {
    const jsonPath = resolve(bridgeDir, "bridge.json");
    if (existsSync(jsonPath)) {
      try {
        return JSON.parse(readFileSync(jsonPath, "utf-8")) as BridgeDef;
      } catch (err) {
        console.warn(`Failed to parse ${jsonPath}: ${err}`);
        return null;
      }
    }
  }

  return null;
}

export function checkMissingBridgeEnv(def: BridgeDef, env: Record<string, string>): BridgeEnvVar[] {
  return def.envVars.filter((v) => v.required && !env[v.name]);
}
