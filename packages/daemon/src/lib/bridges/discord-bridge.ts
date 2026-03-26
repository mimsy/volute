/**
 * Discord bridge — connects Discord to Volute conversations via the bridge API.
 * System-level: one bot per installation, not per-mind.
 */
import { Client, Events, GatewayIntentBits, Partials } from "discord.js";
import { slugify } from "../util/slugify.js";
import { type ContentPart, loadBridgeEnv, onShutdown, sendToBridge } from "./bridge-sdk.js";

const env = loadBridgeEnv();

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error("Missing required env var: DISCORD_TOKEN");
  process.exit(1);
}

const TYPING_INTERVAL_MS = 8000;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMessageTyping,
    GatewayIntentBits.DirectMessageTyping,
  ],
  partials: [Partials.Channel],
});

onShutdown(() => {
  client.destroy();
});

client.once(Events.ClientReady, (c) => {
  console.log(`Discord bridge connected as ${c.user.tag}`);
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;

  const isDM = !message.guild;

  // Build content parts
  const content: ContentPart[] = [];
  let text = message.content;

  // Strip bot mentions
  if (!isDM && message.mentions.has(client.user!)) {
    text = text.replace(new RegExp(`<@!?${client.user!.id}>`, "g"), "").trim();
  }

  if (text) content.push({ type: "text", text });

  // Handle image attachments
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
      content.push({ type: "text", text: "[Image attachment could not be loaded]" });
    }
  }

  if (content.length === 0) return;

  const displayName = message.author.displayName || message.author.username;
  const platformUserId = message.author.username;

  // Build external channel identifier
  const channelName = !isDM && "name" in message.channel ? message.channel.name : undefined;
  const externalChannel = isDM
    ? `@${slugify(message.author.username)}`
    : channelName && message.guild
      ? `${slugify(message.guild.name)}/${slugify(channelName)}`
      : message.channelId;

  if (isDM) {
    // DMs: send typing indicator and wait for response
    const channel = message.channel;
    if ("sendTyping" in channel) {
      const typingInterval = setInterval(() => {
        channel.sendTyping().catch(() => {});
      }, TYPING_INTERVAL_MS);
      channel.sendTyping().catch(() => {});

      try {
        const result = await sendToBridge(env, {
          content,
          platformUserId,
          displayName,
          externalChannel,
          isDM: true,
        });
        if (!result.ok) {
          message.reply(result.error ?? "Failed to process message").catch((err) => {
            console.error(`Failed to send error reply: ${err}`);
          });
        }
      } finally {
        clearInterval(typingInterval);
      }
    }
  } else {
    // Channel messages: always deliver (bridge decides what's mapped)
    const isMentioned = message.mentions.has(client.user!);
    if (isMentioned) {
      // Mention in a channel — send with typing
      const channel = message.channel;
      if ("sendTyping" in channel) {
        const typingInterval = setInterval(() => {
          channel.sendTyping().catch(() => {});
        }, TYPING_INTERVAL_MS);
        channel.sendTyping().catch(() => {});

        try {
          const result = await sendToBridge(env, {
            content,
            platformUserId,
            displayName,
            externalChannel,
            isDM: false,
          });
          if (!result.ok) {
            message.reply(result.error ?? "Failed to process message").catch((err) => {
              console.error(`Failed to send error reply: ${err}`);
            });
          }
        } finally {
          clearInterval(typingInterval);
        }
      }
    } else {
      // Regular channel message
      const result = await sendToBridge(env, {
        content,
        platformUserId,
        displayName,
        externalChannel,
        isDM: false,
      });
      if (!result.ok) {
        message.reply(result.error ?? "Failed to process message").catch((err) => {
          console.error(`Failed to send error reply: ${err}`);
        });
      }
    }
  }
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
