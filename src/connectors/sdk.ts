import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; media_type: string; data: string };

export type NdjsonEvent =
  | { type: "text"; content: string }
  | { type: "image"; media_type: string; data: string }
  | { type: "tool_use"; name: string; input: unknown }
  | { type: "done" };

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

export interface FlushHandlers {
  onFlush(text: string, images: { data: string; media_type: string }[]): Promise<void>;
  onError(message: string): Promise<void>;
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

export async function* readNdjson(body: ReadableStream<Uint8Array>): AsyncGenerator<NdjsonEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          yield JSON.parse(line) as NdjsonEvent;
        } catch {
          console.warn(`ndjson: skipping invalid line: ${line.slice(0, 100)}`);
        }
      }
    }

    if (buffer.trim()) {
      try {
        yield JSON.parse(buffer) as NdjsonEvent;
      } catch {
        console.warn(`ndjson: skipping invalid line: ${buffer.slice(0, 100)}`);
      }
    }
  } finally {
    reader.releaseLock();
  }
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

export async function fireAndForget(env: ConnectorEnv, payload: AgentPayload): Promise<void> {
  try {
    const res = await fetch(`${env.baseUrl}/message`, {
      method: "POST",
      headers: getHeaders(env),
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      console.error(`fireAndForget: agent returned ${res.status}`);
    }

    // Drain the response body to close the connection properly
    if (res.body) {
      const reader = res.body.getReader();
      while (!(await reader.read()).done) {}
    }
  } catch (err) {
    console.error(`Failed to forward message: ${err}`);
  }
}

export async function handleAgentMessage(
  env: ConnectorEnv,
  payload: AgentPayload,
  handlers: FlushHandlers,
): Promise<void> {
  try {
    const res = await fetch(`${env.baseUrl}/message`, {
      method: "POST",
      headers: getHeaders(env),
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`Agent returned ${res.status}: ${body}`);
      await handlers.onError(`Error: agent returned ${res.status}`);
      return;
    }

    if (!res.body) {
      await handlers.onError("Error: no response from agent");
      return;
    }

    let accumulated = "";
    const pendingImages: { data: string; media_type: string }[] = [];

    for await (const event of readNdjson(res.body)) {
      if (event.type === "text") {
        accumulated += event.content;
      } else if (event.type === "image") {
        pendingImages.push({ data: event.data, media_type: event.media_type });
      } else if (event.type === "tool_use") {
        const text = accumulated.trim();
        accumulated = "";
        const images = pendingImages.splice(0);
        if (text || images.length > 0) {
          await handlers.onFlush(text, images);
        }
      } else if (event.type === "done") {
        break;
      }
    }

    const text = accumulated.trim();
    const images = pendingImages.splice(0);
    if (text || images.length > 0) {
      await handlers.onFlush(text, images);
    }
  } catch (err) {
    console.error(`Failed to reach agent at ${env.baseUrl}/message:`, err);
    const errMsg =
      err instanceof TypeError && (err as any).cause?.code === "ECONNREFUSED"
        ? "Agent is not running"
        : `Error: ${err}`;
    await handlers.onError(errMsg);
  }
}
