import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export type ConnectorEnvVar = {
  name: string;
  required: boolean;
  description: string;
  scope: "agent" | "any";
};

export type ConnectorDef = {
  displayName: string;
  description: string;
  envVars: ConnectorEnvVar[];
};

const BUILTIN_DEFS: Record<string, ConnectorDef> = {
  discord: {
    displayName: "Discord",
    description: "Connect to Discord as a bot",
    envVars: [
      {
        name: "DISCORD_TOKEN",
        required: true,
        description: "Discord bot token",
        scope: "agent",
      },
      {
        name: "DISCORD_GUILD_ID",
        required: false,
        description: "Discord server ID (optional, for slash commands)",
        scope: "agent",
      },
    ],
  },
  slack: {
    displayName: "Slack",
    description: "Connect to Slack via Socket Mode",
    envVars: [
      {
        name: "SLACK_BOT_TOKEN",
        required: true,
        description: "Slack bot token (xoxb-...)",
        scope: "agent",
      },
      {
        name: "SLACK_APP_TOKEN",
        required: true,
        description: "Slack app-level token (xapp-...) for Socket Mode",
        scope: "agent",
      },
    ],
  },
  telegram: {
    displayName: "Telegram",
    description: "Connect to Telegram via long polling",
    envVars: [
      {
        name: "TELEGRAM_BOT_TOKEN",
        required: true,
        description: "Telegram bot token from BotFather",
        scope: "agent",
      },
    ],
  },
};

export function getConnectorDef(type: string, connectorDir?: string): ConnectorDef | null {
  if (BUILTIN_DEFS[type]) return BUILTIN_DEFS[type];

  // Check for connector.json alongside custom connector script
  if (connectorDir) {
    const jsonPath = resolve(connectorDir, "connector.json");
    if (existsSync(jsonPath)) {
      try {
        return JSON.parse(readFileSync(jsonPath, "utf-8")) as ConnectorDef;
      } catch (err) {
        console.warn(`Failed to parse ${jsonPath}: ${err}`);
        return null;
      }
    }
  }

  return null;
}

export function checkMissingEnvVars(
  def: ConnectorDef,
  env: Record<string, string>,
): ConnectorEnvVar[] {
  return def.envVars.filter((v) => v.required && !env[v.name]);
}
