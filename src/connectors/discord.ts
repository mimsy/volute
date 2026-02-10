import {
  AttachmentBuilder,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  type Message,
  Partials,
} from "discord.js";
import {
  type AgentPayload,
  type ContentPart,
  fireAndForget,
  handleAgentMessage,
  loadEnv,
  loadFollowedChannels,
  splitMessage,
} from "./sdk.js";

const DISCORD_MAX_LENGTH = 2000;
const TYPING_INTERVAL_MS = 8000;

const env = loadEnv();

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error("Missing required env var: DISCORD_TOKEN");
  process.exit(1);
}

const followedChannelNames = loadFollowedChannels(env, "discord");
const followedChannelIds = new Set<string>();

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
  console.log(`Bridging to agent: ${env.agentName} via ${env.baseUrl}/message`);

  if (followedChannelNames.length > 0) {
    for (const guild of c.guilds.cache.values()) {
      for (const ch of guild.channels.cache.values()) {
        if (ch.type !== ChannelType.GuildText) continue;
        if (followedChannelNames.includes(ch.name)) {
          followedChannelIds.add(ch.id);
          console.log(`Following #${ch.name} (${ch.id}) in ${guild.name}`);
        }
      }
    }
    if (followedChannelIds.size === 0) {
      console.warn(`No channels found matching: ${followedChannelNames.join(", ")}`);
    }
  }
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;

  const isDM = !message.guild;
  const isMentioned = !isDM && message.mentions.has(client.user!);
  const isFollowedChannel = !isDM && followedChannelIds.has(message.channelId);

  if (!isDM && !isMentioned && !isFollowedChannel) return;

  let text = message.content;
  if (isMentioned) {
    text = text.replace(new RegExp(`<@!?${client.user!.id}>`, "g"), "").trim();
  }

  const content: ContentPart[] = [];
  if (text) content.push({ type: "text", text });

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

  const senderName = message.author.displayName || message.author.username;
  const channelKey = `discord:${message.channelId}`;
  const channelName = !isDM && "name" in message.channel ? message.channel.name : undefined;

  const payload: AgentPayload = {
    content,
    channel: channelKey,
    sender: senderName,
    platform: "Discord",
    ...(isDM ? { isDM: true } : {}),
    ...(channelName ? { channelName } : {}),
    ...(message.guild?.name ? { guildName: message.guild.name } : {}),
  };

  if (isFollowedChannel && !isMentioned) {
    await fireAndForget(env, payload);
    return;
  }

  await handleDiscordMessage(message, payload);
});

async function handleDiscordMessage(message: Message, payload: AgentPayload) {
  const channel = message.channel;
  if (!("sendTyping" in channel)) return;
  const typingInterval = setInterval(() => {
    channel.sendTyping().catch(() => {});
  }, TYPING_INTERVAL_MS);
  channel.sendTyping().catch(() => {});

  let replied = false;

  try {
    await handleAgentMessage(env, payload, {
      onFlush: async (text, images) => {
        if (!text && images.length === 0) return;

        const chunks = text ? splitMessage(text, DISCORD_MAX_LENGTH) : [];
        const imageFiles = images.map((img, i) => {
          const ext = img.media_type.split("/")[1] || "png";
          return new AttachmentBuilder(Buffer.from(img.data, "base64"), {
            name: `image-${i}.${ext}`,
          });
        });

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
      },
      onError: async (msg) => {
        await message.reply(msg).catch(() => {});
      },
    });
  } finally {
    clearInterval(typingInterval);
  }
}

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
