import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  Message,
  AttachmentBuilder,
} from "discord.js";
import { writeFileSync, unlinkSync, mkdirSync } from "fs";
import { resolve } from "path";
import { resolveAgent } from "../lib/registry.js";
import { loadMergedEnv } from "../lib/env.js";
import { readNdjson } from "../lib/ndjson.js";
import type { MoltContentPart } from "../types.js";

const DISCORD_MAX_LENGTH = 2000;
const TYPING_INTERVAL_MS = 8000;

export async function run(args: string[]) {
  const name = args[0];
  if (!name) {
    console.error("Usage: molt connect discord <agent>");
    process.exit(1);
  }

  const { entry, dir } = resolveAgent(name);
  const env = loadMergedEnv(dir);
  const token = env.DISCORD_TOKEN;

  if (!token) {
    console.error(
      "DISCORD_TOKEN not set. Run: molt env set DISCORD_TOKEN <token>",
    );
    process.exit(1);
  }

  // Write PID file
  const moltDir = resolve(dir, ".molt");
  const pidPath = resolve(moltDir, "discord.pid");
  mkdirSync(moltDir, { recursive: true });
  writeFileSync(pidPath, String(process.pid));

  function cleanupPid() {
    try { unlinkSync(pidPath); } catch {}
  }

  const baseUrl = `http://localhost:${entry.port}`;

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
    cleanupPid();
    process.exit(0);
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  client.once(Events.ClientReady, (c) => {
    console.log(`Connected to Discord as ${c.user.tag}`);
    console.log(`Bridging to agent: ${name} (port ${entry.port})`);
    // Write connection state
    const statePath = resolve(moltDir, "discord.json");
    writeFileSync(statePath, JSON.stringify({
      username: c.user.tag,
      userId: c.user.id,
      connectedAt: new Date().toISOString(),
    }, null, 2));
  });

  client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot) return;

    const isDM = !message.guild;
    const isMentioned =
      !isDM && message.mentions.has(client.user!);

    if (!isDM && !isMentioned) return;

    let text = message.content;
    if (isMentioned) {
      text = text.replace(new RegExp(`<@!?${client.user!.id}>`, "g"), "").trim();
    }

    const sender = message.author.displayName || message.author.username;
    const channelName = "name" in message.channel ? message.channel.name : null;
    const channelLabel = channelName
      ? `#${channelName} in ${message.guild!.name}`
      : "DM";
    const context = `[Discord: ${sender} in ${channelLabel} — channel discord:${message.channelId}]`;

    const content: MoltContentPart[] = [];
    content.push({ type: "text", text: text ? `${context}\n${text}` : context });

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

    await handleAgentRequest(message, baseUrl, content);
  });

  client.login(token);
}

function splitMessage(text: string): string[] {
  const chunks: string[] = [];
  while (text.length > DISCORD_MAX_LENGTH) {
    // Try to split at a newline near the limit
    let splitAt = text.lastIndexOf("\n", DISCORD_MAX_LENGTH);
    if (splitAt < DISCORD_MAX_LENGTH / 2) splitAt = DISCORD_MAX_LENGTH;
    chunks.push(text.slice(0, splitAt));
    text = text.slice(splitAt).replace(/^\n/, "");
  }
  if (text) chunks.push(text);
  return chunks;
}

async function handleAgentRequest(
  message: Message,
  baseUrl: string,
  content: MoltContentPart[],
) {
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

    // If only images, send with zero-width space
    if (chunks.length === 0 && imageFiles.length > 0) {
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
          await channel.send(opts);
        }
      } catch (err) {
        console.error(`Failed to send message: ${err}`);
      }
    }
  }

  try {
    const res = await fetch(`${baseUrl}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content,
        channel: `discord:${message.channelId}`,
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
