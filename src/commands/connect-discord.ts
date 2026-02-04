import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  Message,
  AttachmentBuilder,
} from "discord.js";
import { resolveAgent } from "../lib/registry.js";
import { loadMergedEnv } from "../lib/env.js";
import { readNdjson } from "../lib/ndjson.js";
import type { MoltContentPart } from "../types.js";

const DISCORD_MAX_LENGTH = 2000;
const EDIT_DEBOUNCE_MS = 1000;
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

  client.once(Events.ClientReady, (c) => {
    console.log(`Connected to Discord as ${c.user.tag}`);
    console.log(`Bridging to agent: ${name} (port ${entry.port})`);
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

    const content: MoltContentPart[] = [];
    if (text) {
      content.push({ type: "text", text });
    }

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

async function handleAgentRequest(
  message: Message,
  baseUrl: string,
  content: MoltContentPart[],
) {
  // Start typing
  const channel = message.channel;
  if (!("sendTyping" in channel)) return;
  const typingInterval = setInterval(() => {
    channel.sendTyping().catch(() => {});
  }, TYPING_INTERVAL_MS);
  channel.sendTyping().catch(() => {});

  let replyMsg: Message | null = null;
  let accumulated = "";
  let pendingImages: { data: string; media_type: string }[] = [];
  let editTimer: ReturnType<typeof setTimeout> | null = null;

  const flushEdit = async () => {
    if (editTimer) {
      clearTimeout(editTimer);
      editTimer = null;
    }
    if (replyMsg && accumulated) {
      const text = accumulated.slice(0, DISCORD_MAX_LENGTH);
      try {
        await replyMsg.edit(text);
      } catch (err) {
        console.error(`Failed to edit message: ${err}`);
      }
    }
  };

  const scheduleEdit = () => {
    if (editTimer) return;
    editTimer = setTimeout(() => {
      editTimer = null;
      flushEdit();
    }, EDIT_DEBOUNCE_MS);
  };

  const sendChunk = async (text: string, final: boolean) => {
    const files = final
      ? pendingImages.map((img, i) => {
          const ext = img.media_type.split("/")[1] || "png";
          return new AttachmentBuilder(Buffer.from(img.data, "base64"), {
            name: `image-${i}.${ext}`,
          });
        })
      : [];

    try {
      if (!replyMsg) {
        replyMsg = await message.reply({
          content: text || "\u200b",
          files,
        });
      } else {
        await replyMsg.edit({ content: text || "\u200b", files });
      }
    } catch (err) {
      console.error(`Failed to send/edit message: ${err}`);
    }
  };

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

        // Check if we need to split
        if (accumulated.length > DISCORD_MAX_LENGTH) {
          const chunk = accumulated.slice(0, DISCORD_MAX_LENGTH);
          accumulated = accumulated.slice(DISCORD_MAX_LENGTH);
          await sendChunk(chunk, false);
          replyMsg = null; // Next chunk becomes a new message
        } else if (!replyMsg) {
          // Send initial reply
          await sendChunk(accumulated, false);
        } else {
          scheduleEdit();
        }
      } else if (event.type === "image") {
        pendingImages.push({
          data: event.data,
          media_type: event.media_type,
        });
      } else if (event.type === "done") {
        break;
      }
    }

    // Final flush
    await flushEdit();
    if (pendingImages.length > 0 || accumulated) {
      await sendChunk(accumulated || "\u200b", true);
    }
  } catch (err) {
    const errMsg =
      err instanceof TypeError && (err as any).cause?.code === "ECONNREFUSED"
        ? "Agent is not running"
        : `Error: ${err}`;
    const lastReply = replyMsg as Message | null;
    if (lastReply) {
      try {
        await lastReply.edit(`${accumulated}\n\n_${errMsg}_`);
      } catch {
        await message.reply(errMsg).catch(() => {});
      }
    } else {
      await message.reply(errMsg).catch(() => {});
    }
  } finally {
    clearInterval(typingInterval);
    if (editTimer) clearTimeout(editTimer);
  }
}
