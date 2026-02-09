import {
  AttachmentBuilder,
  Client,
  Events,
  GatewayIntentBits,
  type Message,
  Partials,
} from "discord.js";

const DISCORD_MAX_LENGTH = 2000;
const TYPING_INTERVAL_MS = 8000;

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
const token = process.env.DISCORD_TOKEN;

if (!agentPort || !agentName) {
  console.error("Missing required env vars: VOLUTE_AGENT_PORT, VOLUTE_AGENT_NAME");
  process.exit(1);
}

if (!token) {
  console.error("Missing required env var: DISCORD_TOKEN");
  process.exit(1);
}

const guildId = process.env.DISCORD_GUILD_ID;
const daemonUrl = process.env.VOLUTE_DAEMON_URL;
const daemonToken = process.env.VOLUTE_DAEMON_TOKEN;

const baseUrl = daemonUrl
  ? `${daemonUrl}/api/agents/${encodeURIComponent(agentName)}`
  : `http://localhost:${agentPort}`;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel],
});

function shutdown() {
  client.destroy();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

client.once(Events.ClientReady, (c) => {
  console.log(`Connected to Discord as ${c.user.tag}`);
  console.log(`Bridging to agent: ${agentName} (port ${agentPort})`);
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;

  const isDM = !message.guild;
  const isMentioned = !isDM && message.mentions.has(client.user!);

  if (!isDM && !isMentioned) return;

  let text = message.content;
  if (isMentioned) {
    text = text.replace(new RegExp(`<@!?${client.user!.id}>`, "g"), "").trim();
  }

  const content: ContentPart[] = [];
  if (text) content.push({ type: "text", text });

  // Download image attachments
  for (const attachment of message.attachments.values()) {
    if (!attachment.contentType?.startsWith("image/")) continue;
    try {
      const res = await fetch(attachment.url);
      const buffer = Buffer.from(await res.arrayBuffer());
      content.push({
        type: "image",
        media_type: attachment.contentType,
        data: buffer.toString("base64"),
      });
    } catch (err) {
      console.error(`Failed to download attachment: ${err}`);
    }
  }

  if (content.length === 0) return;

  await handleAgentRequest(message, content);
});

async function loginWithRetry() {
  try {
    await client.login(token);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const match = msg.match(/resets at (.+)/);
    if (match) {
      const resetAt = new Date(match[1]);
      const waitMs = resetAt.getTime() - Date.now();
      if (waitMs > 0) {
        console.error(`Session limit hit, waiting until ${resetAt.toISOString()}...`);
        await new Promise((r) => setTimeout(r, waitMs + 5000));
        return loginWithRetry();
      }
    }
    throw err;
  }
}

loginWithRetry().catch((err) => {
  console.error("Failed to connect to Discord:", err);
  process.exit(1);
});

function splitMessage(text: string): string[] {
  const chunks: string[] = [];
  while (text.length > DISCORD_MAX_LENGTH) {
    let splitAt = text.lastIndexOf("\n", DISCORD_MAX_LENGTH);
    if (splitAt < DISCORD_MAX_LENGTH / 2) splitAt = DISCORD_MAX_LENGTH;
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
          // skip invalid line
        }
      }
    }

    if (buffer.trim()) {
      try {
        yield JSON.parse(buffer) as NdjsonEvent;
      } catch {
        // skip
      }
    }
  } finally {
    reader.releaseLock();
  }
}

async function handleAgentRequest(message: Message, content: ContentPart[]) {
  const channel = message.channel;
  if (!("sendTyping" in channel)) return;
  const typingInterval = setInterval(() => {
    channel.sendTyping().catch(() => {});
  }, TYPING_INTERVAL_MS);
  channel.sendTyping().catch(() => {});

  let accumulated = "";
  const pendingImages: { data: string; media_type: string }[] = [];
  let replied = false;

  async function flush() {
    const text = accumulated.trim();
    accumulated = "";
    if (!text && pendingImages.length === 0) return;

    const chunks = text ? splitMessage(text) : [];
    const imageFiles = pendingImages.splice(0).map((img, i) => {
      const ext = img.media_type.split("/")[1] || "png";
      return new AttachmentBuilder(Buffer.from(img.data, "base64"), {
        name: `image-${i}.${ext}`,
      });
    });

    if (chunks.length === 0 && imageFiles.length > 0) {
      // @ts-expect-error PartialGroupDMChannel excluded by sendTyping check above
      const sendFn = replied ? channel.send.bind(channel) : message.reply.bind(message);
      await sendFn({ content: "\u200b", files: imageFiles }).catch((err: unknown) => {
        console.error(`Failed to send message: ${err}`);
      });
      replied = true;
      return;
    }

    for (let i = 0; i < chunks.length; i++) {
      const isLast = i === chunks.length - 1;
      const opts: { content: string; files?: AttachmentBuilder[] } = {
        content: chunks[i],
      };
      if (isLast && imageFiles.length > 0) opts.files = imageFiles;

      try {
        if (!replied) {
          await message.reply(opts);
          replied = true;
        } else {
          // @ts-expect-error PartialGroupDMChannel excluded by sendTyping check above
          await channel.send(opts);
        }
      } catch (err) {
        console.error(`Failed to send message: ${err}`);
      }
    }
  }

  const senderName = message.author.displayName || message.author.username;
  const channelKey = `discord:${message.channelId}`;
  const isDM = !message.guild;
  const channelName = !isDM && "name" in message.channel ? message.channel.name : null;

  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (daemonUrl && daemonToken) {
      headers.Authorization = `Bearer ${daemonToken}`;
      headers.Origin = daemonUrl;
    }

    const res = await fetch(`${baseUrl}/message`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        content,
        channel: channelKey,
        sender: senderName,
        platform: "Discord",
        ...(isDM ? { isDM: true } : {}),
        ...(channelName ? { channelName } : {}),
        ...(message.guild?.name ? { guildName: message.guild.name } : {}),
      }),
    });

    if (!res.ok) {
      await message.reply(`Error: agent returned ${res.status}`);
      clearInterval(typingInterval);
      return;
    }

    if (!res.body) {
      await message.reply("Error: no response from agent");
      clearInterval(typingInterval);
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
    const errMsg =
      err instanceof TypeError && (err as any).cause?.code === "ECONNREFUSED"
        ? "Agent is not running"
        : `Error: ${err}`;
    await message.reply(errMsg).catch(() => {});
  } finally {
    clearInterval(typingInterval);
  }
}
