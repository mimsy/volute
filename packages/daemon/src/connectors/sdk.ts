import { slugify } from "../lib/slugify.js";

export { slugify } from "../lib/slugify.js";

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; media_type: string; data: string };

export interface ConnectorEnv {
  mindPort: string;
  mindName: string;
  mindDir: string | undefined;
  baseUrl: string;
  daemonUrl: string | undefined;
  daemonToken: string | undefined;
}

export interface MindPayload {
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
  const mindPort = process.env.VOLUTE_MIND_PORT;
  const mindName = process.env.VOLUTE_MIND_NAME;

  if (!mindPort || !mindName) {
    console.error("Missing required env vars: VOLUTE_MIND_PORT, VOLUTE_MIND_NAME");
    process.exit(1);
  }

  const mindDir = process.env.VOLUTE_MIND_DIR;
  const daemonUrl = process.env.VOLUTE_DAEMON_URL;
  const daemonToken = process.env.VOLUTE_DAEMON_TOKEN;

  const baseUrl = daemonUrl
    ? `${daemonUrl}/api/minds/${encodeURIComponent(mindName)}`
    : `http://127.0.0.1:${mindPort}`;

  return { mindPort, mindName, mindDir, baseUrl, daemonUrl, daemonToken };
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

export async function sendToMind(
  env: ConnectorEnv,
  payload: MindPayload,
): Promise<{ ok: boolean; error?: string }> {
  const url = `${env.baseUrl}/message`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: getHeaders(env),
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`Mind returned ${res.status}: ${body}`);
      return { ok: false, error: `Mind returned ${res.status}` };
    }

    return { ok: true };
  } catch (err) {
    console.error(`Failed to forward message: ${err}`);
    const isConnRefused =
      err instanceof TypeError &&
      (err.cause as NodeJS.ErrnoException | undefined)?.code === "ECONNREFUSED";
    return { ok: false, error: isConnRefused ? "Mind is not running" : "Failed to reach mind" };
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
