import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { slugify } from "../lib/slugify.js";

export { slugify } from "../lib/slugify.js";

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; media_type: string; data: string };

export interface ConnectorEnv {
  agentPort: string;
  agentName: string;
  agentDir: string | undefined;
  baseUrl: string;
  daemonUrl: string | undefined;
  daemonToken: string | undefined;
}

export interface AgentPayload {
  content: ContentPart[];
  channel: string;
  sender: string;
  platform: string;
  isDM?: boolean;
  channelName?: string;
  serverName?: string;
  participantCount?: number;
}

export function loadEnv(): ConnectorEnv {
  const agentPort = process.env.VOLUTE_AGENT_PORT;
  const agentName = process.env.VOLUTE_AGENT_NAME;

  if (!agentPort || !agentName) {
    console.error("Missing required env vars: VOLUTE_AGENT_PORT, VOLUTE_AGENT_NAME");
    process.exit(1);
  }

  const agentDir = process.env.VOLUTE_AGENT_DIR;
  const daemonUrl = process.env.VOLUTE_DAEMON_URL;
  const daemonToken = process.env.VOLUTE_DAEMON_TOKEN;

  const baseUrl = daemonUrl
    ? `${daemonUrl}/api/agents/${encodeURIComponent(agentName)}`
    : `http://127.0.0.1:${agentPort}`;

  return { agentPort, agentName, agentDir, baseUrl, daemonUrl, daemonToken };
}

export function loadFollowedChannels(env: ConnectorEnv, platform: string): string[] {
  if (!env.agentDir) return [];
  const configPath = resolve(env.agentDir, "home/.config/volute.json");
  if (!existsSync(configPath)) return [];
  try {
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    const platformConfig = config[platform];
    return platformConfig?.channels ?? platformConfig?.chats ?? [];
  } catch (err) {
    console.warn(`Failed to load agent config: ${err}`);
    return [];
  }
}

export function splitMessage(text: string, maxLength: number): string[] {
  const chunks: string[] = [];
  while (text.length > maxLength) {
    let splitAt = text.lastIndexOf("\n", maxLength);
    if (splitAt < maxLength / 2) splitAt = maxLength;
    chunks.push(text.slice(0, splitAt));
    text = text.slice(splitAt).replace(/^\n/, "");
  }
  if (text) chunks.push(text);
  return chunks;
}

export function getHeaders(env: ConnectorEnv): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (env.daemonUrl && env.daemonToken) {
    headers.Authorization = `Bearer ${env.daemonToken}`;
    headers.Origin = env.daemonUrl;
  }
  return headers;
}

export function onShutdown(cleanup: () => void | Promise<void>): void {
  const handler = () => {
    Promise.resolve(cleanup()).then(
      () => process.exit(0),
      (err) => {
        console.error(`Shutdown error: ${err}`);
        process.exit(1);
      },
    );
  };
  process.on("SIGINT", handler);
  process.on("SIGTERM", handler);
}

export function reportTyping(
  env: ConnectorEnv,
  channel: string,
  sender: string,
  active: boolean,
): void {
  fetch(`${env.baseUrl}/typing`, {
    method: "POST",
    headers: getHeaders(env),
    body: JSON.stringify({ channel, sender, active }),
  }).catch((err) => {
    console.warn(`[typing] failed to report for ${sender} on ${channel}: ${err}`);
  });
}

export async function sendToAgent(env: ConnectorEnv, payload: AgentPayload): Promise<void> {
  try {
    const res = await fetch(`${env.baseUrl}/message`, {
      method: "POST",
      headers: getHeaders(env),
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`Agent returned ${res.status}: ${body}`);
    }
  } catch (err) {
    console.error(`Failed to forward message: ${err}`);
  }
}

export interface ChannelSlugMeta {
  channelName?: string;
  serverName?: string;
  isDM?: boolean;
  senderName?: string;
  recipients?: string[];
  platformId?: string;
}

export interface ChannelEntry {
  platformId: string;
  platform: string;
  name?: string;
  server?: string;
  type?: "channel" | "dm" | "group";
}

export function buildChannelSlug(platform: string, meta: ChannelSlugMeta): string {
  if (meta.isDM) {
    if (meta.recipients && meta.recipients.length > 0) {
      const sorted = meta.recipients.map(slugify).sort();
      return `${platform}:@${sorted.join(",")}`;
    }
    if (meta.senderName) {
      return `${platform}:@${slugify(meta.senderName)}`;
    }
  }

  if (meta.channelName && meta.serverName) {
    return `${platform}:${slugify(meta.serverName)}/${slugify(meta.channelName)}`;
  }

  if (meta.channelName) {
    return `${platform}:${slugify(meta.channelName)}`;
  }

  if (meta.platformId) {
    return `${platform}:${meta.platformId}`;
  }

  return `${platform}:unknown`;
}

export function readChannelMap(agentDir: string): Record<string, ChannelEntry> {
  const filePath = join(agentDir, ".volute", "channels.json");
  if (!existsSync(filePath)) return {};
  try {
    return JSON.parse(readFileSync(filePath, "utf-8"));
  } catch {
    return {};
  }
}

export function writeChannelEntry(agentDir: string, slug: string, entry: ChannelEntry): void {
  const voluteDir = join(agentDir, ".volute");
  mkdirSync(voluteDir, { recursive: true });
  const filePath = join(voluteDir, "channels.json");
  const map = readChannelMap(agentDir);
  map[slug] = entry;
  writeFileSync(filePath, JSON.stringify(map, null, 2) + "\n");
}

export function resolveChannelId(agentDir: string, slug: string): string {
  const map = readChannelMap(agentDir);
  if (map[slug]) {
    return map[slug].platformId;
  }
  const colonIndex = slug.indexOf(":");
  return colonIndex >= 0 ? slug.slice(colonIndex + 1) : slug;
}
