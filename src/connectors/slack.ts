import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { App } from "@slack/bolt";

const SLACK_MAX_LENGTH = 4000;

type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; media_type: string; data: string };

type NdjsonEvent =
  | { type: "text"; content: string }
  | { type: "image"; media_type: string; data: string }
  | { type: "tool_use"; name: string; input: unknown }
  | { type: "done" };

const agentPort = process.env.VOLUTE_AGENT_PORT;
const agentName = process.env.VOLUTE_AGENT_NAME;
const botToken = process.env.SLACK_BOT_TOKEN;
const appToken = process.env.SLACK_APP_TOKEN;

if (!agentPort || !agentName) {
  console.error("Missing required env vars: VOLUTE_AGENT_PORT, VOLUTE_AGENT_NAME");
  process.exit(1);
}

if (!botToken || !appToken) {
  console.error("Missing required env vars: SLACK_BOT_TOKEN, SLACK_APP_TOKEN");
  process.exit(1);
}

const agentDir = process.env.VOLUTE_AGENT_DIR;
const daemonUrl = process.env.VOLUTE_DAEMON_URL;
const daemonToken = process.env.VOLUTE_DAEMON_TOKEN;

// Load followed channels from agent config
let followedChannelNames: string[] = [];
if (agentDir) {
  const configPath = resolve(agentDir, "home/.config/volute.json");
  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, "utf-8"));
      followedChannelNames = config.slack?.channels ?? [];
    } catch (err) {
      console.warn(`Failed to load agent config: ${err}`);
    }
  }
}

// Resolved at startup — set of channel IDs corresponding to followedChannelNames
const followedChannelIds = new Set<string>();

const baseUrl = daemonUrl
  ? `${daemonUrl}/api/agents/${encodeURIComponent(agentName)}`
  : `http://127.0.0.1:${agentPort}`;

const app = new App({
  token: botToken,
  socketMode: true,
  appToken,
});

let botUserId: string | undefined;

function splitMessage(text: string): string[] {
  const chunks: string[] = [];
  while (text.length > SLACK_MAX_LENGTH) {
    let splitAt = text.lastIndexOf("\n", SLACK_MAX_LENGTH);
    if (splitAt < SLACK_MAX_LENGTH / 2) splitAt = SLACK_MAX_LENGTH;
    chunks.push(text.slice(0, splitAt));
    text = text.slice(splitAt).replace(/^\n/, "");
  }
  if (text) chunks.push(text);
  return chunks;
}

async function* readNdjson(body: ReadableStream<Uint8Array>): AsyncGenerator<NdjsonEvent> {
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

function getHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (daemonUrl && daemonToken) {
    headers.Authorization = `Bearer ${daemonToken}`;
    headers.Origin = daemonUrl;
  }
  return headers;
}

async function sendFireAndForget(
  channelId: string,
  channelName: string | undefined,
  senderName: string,
  content: ContentPart[],
) {
  const channelKey = `slack:${channelId}`;
  try {
    const res = await fetch(`${baseUrl}/message`, {
      method: "POST",
      headers: getHeaders(),
      body: JSON.stringify({
        content,
        channel: channelKey,
        sender: senderName,
        platform: "Slack",
        ...(channelName ? { channelName } : {}),
      }),
    });

    if (!res.ok) {
      console.error(`sendFireAndForget: agent returned ${res.status}`);
    }

    // Drain the response body
    if (res.body) {
      const reader = res.body.getReader();
      while (!(await reader.read()).done) {}
    }
  } catch (err) {
    console.error(`Failed to forward followed-channel message: ${err}`);
  }
}

async function handleAgentRequest(
  channelId: string,
  channelName: string | undefined,
  senderName: string,
  content: ContentPart[],
  isDM: boolean,
  say: (text: string) => Promise<unknown>,
) {
  let accumulated = "";
  const pendingImages: { data: string; media_type: string }[] = [];

  async function flush() {
    const text = accumulated.trim();
    accumulated = "";
    if (!text && pendingImages.length === 0) return;

    // Send images via file upload
    for (const img of pendingImages.splice(0)) {
      const ext = img.media_type.split("/")[1] || "png";
      try {
        await app.client.filesUploadV2({
          channel_id: channelId,
          file: Buffer.from(img.data, "base64"),
          filename: `image.${ext}`,
        });
      } catch (err) {
        console.error(`Failed to upload image: ${err}`);
      }
    }

    if (!text) return;

    const chunks = splitMessage(text);
    for (const chunk of chunks) {
      try {
        await say(chunk);
      } catch (err) {
        console.error(`Failed to send message: ${err}`);
      }
    }
  }

  const channelKey = `slack:${channelId}`;

  try {
    const res = await fetch(`${baseUrl}/message`, {
      method: "POST",
      headers: getHeaders(),
      body: JSON.stringify({
        content,
        channel: channelKey,
        sender: senderName,
        platform: "Slack",
        ...(isDM ? { isDM: true } : {}),
        ...(channelName ? { channelName } : {}),
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`Agent returned ${res.status}: ${body}`);
      await say(`Error: agent returned ${res.status}`).catch(() => {});
      return;
    }

    if (!res.body) {
      await say("Error: no response from agent").catch(() => {});
      return;
    }

    for await (const event of readNdjson(res.body)) {
      if (event.type === "text") {
        accumulated += event.content;
      } else if (event.type === "image") {
        pendingImages.push({
          data: event.data,
          media_type: event.media_type,
        });
      } else if (event.type === "tool_use") {
        await flush();
      } else if (event.type === "done") {
        break;
      }
    }

    await flush();
  } catch (err) {
    console.error(`Failed to reach agent at ${baseUrl}/message:`, err);
    const errMsg =
      err instanceof TypeError && (err as any).cause?.code === "ECONNREFUSED"
        ? "Agent is not running"
        : `Error: ${err}`;
    await say(errMsg).catch(() => {});
  }
}

// Handle direct messages
app.message(async ({ message, say }) => {
  // Skip bot messages and subtypes (edits, joins, etc.)
  if (message.subtype) return;
  if (!("user" in message) || !("text" in message)) return;
  if ("bot_id" in message && message.bot_id) return;

  const isDM = message.channel_type === "im";
  const isMentioned = !isDM && botUserId && message.text?.includes(`<@${botUserId}>`);
  const isFollowedChannel = !isDM && followedChannelIds.has(message.channel);

  if (!isDM && !isMentioned && !isFollowedChannel) return;

  let text = message.text ?? "";
  if (isMentioned && botUserId) {
    text = text.replace(new RegExp(`<@${botUserId}>`, "g"), "").trim();
  }

  const content: ContentPart[] = [];
  if (text) content.push({ type: "text", text });

  // Download image attachments
  if ("files" in message && message.files) {
    for (const file of message.files) {
      if (!file.mimetype?.startsWith("image/") || !file.url_private) continue;
      try {
        const res = await fetch(file.url_private, {
          headers: { Authorization: `Bearer ${botToken}` },
        });
        if (!res.ok) {
          console.error(`Failed to download attachment: HTTP ${res.status}`);
          continue;
        }
        const buffer = Buffer.from(await res.arrayBuffer());
        content.push({
          type: "image",
          media_type: file.mimetype,
          data: buffer.toString("base64"),
        });
      } catch (err) {
        console.error(`Failed to download attachment: ${err}`);
      }
    }
  }

  if (content.length === 0) return;

  // Look up channel name
  let channelName: string | undefined;
  if (!isDM) {
    try {
      const info = (await app.client.conversations.info({
        channel: message.channel,
      })) as { channel?: { name?: string } };
      channelName = info.channel?.name;
    } catch (err) {
      console.warn(`Failed to get channel name: ${err}`);
    }
  }

  // Look up user display name
  let senderName = message.user;
  try {
    const userInfo = (await app.client.users.info({
      user: message.user,
    })) as { user?: { profile?: { display_name?: string; real_name?: string } } };
    senderName =
      userInfo.user?.profile?.display_name || userInfo.user?.profile?.real_name || message.user;
  } catch (err) {
    console.warn(`Failed to get user info: ${err}`);
  }

  // Followed channel (not a mention) → fire and forget
  if (isFollowedChannel && !isMentioned) {
    await sendFireAndForget(message.channel, channelName, senderName, content);
    return;
  }

  await handleAgentRequest(message.channel, channelName, senderName, content, isDM, (text) =>
    say(text),
  );
});

// app_mention events are handled via the message listener above (which detects
// <@botUserId> mentions). We don't register a separate app_mention handler to
// avoid duplicate processing — the message event is more reliable since it
// includes file attachments.

async function start() {
  await app.start();

  // Get bot user ID for mention detection — fatal if it fails
  const auth = (await app.client.auth.test()) as { user_id?: string };
  if (!auth.user_id) {
    throw new Error("auth.test succeeded but returned no user_id");
  }
  botUserId = auth.user_id;
  console.log(`Connected to Slack as bot user ${botUserId}`);

  console.log(`Bridging to agent: ${agentName} via ${baseUrl}/message`);

  // Resolve followed channel names to IDs
  if (followedChannelNames.length > 0) {
    try {
      let cursor: string | undefined;
      do {
        const result = (await app.client.conversations.list({
          types: "public_channel,private_channel",
          limit: 200,
          ...(cursor ? { cursor } : {}),
        })) as {
          channels?: { id: string; name: string }[];
          response_metadata?: { next_cursor?: string };
        };
        for (const ch of result.channels ?? []) {
          if (followedChannelNames.includes(ch.name)) {
            followedChannelIds.add(ch.id);
            console.log(`Following #${ch.name} (${ch.id})`);
          }
        }
        cursor = result.response_metadata?.next_cursor || undefined;
      } while (cursor);
    } catch (err) {
      console.error(`Failed to resolve channel names: ${err}`);
    }
    if (followedChannelIds.size === 0 && followedChannelNames.length > 0) {
      console.warn(`No channels found matching: ${followedChannelNames.join(", ")}`);
    }
  }
}

function shutdown() {
  app
    .stop()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(`Shutdown error: ${err}`);
      process.exit(1);
    });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

start().catch((err) => {
  console.error("Failed to start Slack connector:", err);
  process.exit(1);
});
