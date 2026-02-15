import { ChannelType, Client, Events, GatewayIntentBits, type Message, Partials } from "discord.js";
import {
  type AgentPayload,
  buildChannelSlug,
  type ContentPart,
  loadEnv,
  loadFollowedChannels,
  reportTyping,
  sendToAgent,
  slugify,
  writeChannelEntry,
} from "./sdk.js";

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
    GatewayIntentBits.GuildMessageTyping,
    GatewayIntentBits.DirectMessageTyping,
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
  const channelName = !isDM && "name" in message.channel ? message.channel.name : undefined;
  const channelKey = isDM
    ? buildChannelSlug("discord", {
        isDM: true,
        recipients: [message.author.username],
      })
    : buildChannelSlug("discord", {
        channelName: channelName ?? message.channelId,
        serverName: message.guild?.name,
      });

  try {
    writeChannelEntry(env.agentName, channelKey, {
      platformId: message.channelId,
      platform: "discord",
      name: channelName ? `#${channelName}` : undefined,
      server: message.guild?.name,
      type: isDM ? "dm" : "channel",
    });
  } catch (err) {
    console.error(`[discord] failed to write channel entry for ${channelKey}:`, err);
  }

  // Determine participant count: DMs are always 1:1 for bots, guild channels use memberCount
  const participantCount = isDM ? 2 : message.guild?.memberCount;

  const payload: AgentPayload = {
    content,
    channel: channelKey,
    sender: senderName,
    platform: "Discord",
    ...(isDM ? { isDM: true } : {}),
    ...(channelName ? { channelName } : {}),
    ...(message.guild?.name ? { serverName: message.guild.name } : {}),
    ...(participantCount ? { participantCount } : {}),
  };

  // Clear typing indicator — the user just sent a message, they're no longer typing
  reportTyping(env, channelKey, senderName, false);

  if (isFollowedChannel && !isMentioned) {
    const result = await sendToAgent(env, payload);
    if (!result.ok)
      message.reply(result.error ?? "Failed to process message").catch((err) => {
        console.warn(`[discord] failed to send error reply: ${err}`);
      });
    return;
  }

  await handleDiscordMessage(message, payload);
});

client.on(Events.TypingStart, (typing) => {
  if (typing.user.bot) return;
  const sender = typing.user.displayName || typing.user.username || typing.user.id || "unknown";
  const typingChannel = typing.guild
    ? `discord:${slugify(typing.guild.name)}/${slugify("name" in typing.channel ? String((typing.channel as any).name) : typing.channel.id)}`
    : `discord:@${slugify(typing.user.username ?? typing.user.id)}`;
  reportTyping(env, typingChannel, sender, true);
});

async function handleDiscordMessage(message: Message, payload: AgentPayload) {
  const channel = message.channel;
  if (!("sendTyping" in channel)) return;
  const typingInterval = setInterval(() => {
    channel.sendTyping().catch((err: unknown) => {
      console.warn(`[discord] sendTyping failed: ${err}`);
    });
  }, TYPING_INTERVAL_MS);
  channel.sendTyping().catch((err: unknown) => {
    console.warn(`[discord] sendTyping failed: ${err}`);
  });

  try {
    const result = await sendToAgent(env, payload);
    if (!result.ok)
      message.reply(result.error ?? "Failed to process message").catch((err) => {
        console.warn(`[discord] failed to send error reply: ${err}`);
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
