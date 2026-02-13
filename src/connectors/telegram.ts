import { Telegraf } from "telegraf";
import { message } from "telegraf/filters";
import {
  type AgentPayload,
  buildChannelSlug,
  type ContentPart,
  loadEnv,
  loadFollowedChannels,
  sendToAgent,
  writeChannelEntry,
} from "./sdk.js";

const TYPING_INTERVAL_MS = 5000;

const env = loadEnv();

const botToken = process.env.TELEGRAM_BOT_TOKEN;
if (!botToken) {
  console.error("Missing required env var: TELEGRAM_BOT_TOKEN");
  process.exit(1);
}

const followedChatIds = loadFollowedChannels(env, "telegram");
const followedChatIdSet = new Set(followedChatIds.map(String));

const bot = new Telegraf(botToken);

bot.on(message("text"), async (ctx) => {
  if (ctx.message.from.is_bot) return;

  const isDM = ctx.chat.type === "private";
  const botUsername = ctx.botInfo.username;
  const isMentioned =
    !isDM &&
    ctx.message.entities?.some(
      (e) =>
        e.type === "mention" &&
        ctx.message.text.substring(e.offset, e.offset + e.length) === `@${botUsername}`,
    );
  const isFollowedChat = !isDM && followedChatIdSet.has(String(ctx.chat.id));

  if (!isDM && !isMentioned && !isFollowedChat) return;

  let text = ctx.message.text;
  if (isMentioned && botUsername) {
    text = text.replace(new RegExp(`@${botUsername}`, "g"), "").trim();
  }

  const content: ContentPart[] = [];
  if (text) content.push({ type: "text", text });

  if (content.length === 0) return;

  const senderName =
    ctx.message.from.first_name +
    (ctx.message.from.last_name ? ` ${ctx.message.from.last_name}` : "");
  const chatTitle = "title" in ctx.chat ? ctx.chat.title : undefined;

  let participantCount: number | undefined = isDM ? 2 : undefined;
  if (!isDM) {
    try {
      participantCount = await ctx.telegram.getChatMembersCount(ctx.chat.id);
    } catch (err) {
      console.warn(`Failed to get member count for chat ${ctx.chat.id}: ${err}`);
    }
  }

  const channelSlug = isDM
    ? buildChannelSlug("telegram", {
        isDM: true,
        senderName: ctx.message.from.username ?? ctx.message.from.first_name,
      })
    : buildChannelSlug("telegram", {
        channelName: chatTitle ?? String(ctx.chat.id),
      });

  if (env.agentDir) {
    writeChannelEntry(env.agentDir, channelSlug, {
      platformId: String(ctx.chat.id),
      platform: "telegram",
      name: chatTitle,
      type: isDM ? "dm" : "channel",
    });
  }

  const payload: AgentPayload = {
    content,
    channel: channelSlug,
    sender: senderName,
    platform: "Telegram",
    ...(isDM ? { isDM: true } : {}),
    ...(chatTitle ? { channelName: chatTitle } : {}),
    ...(participantCount ? { participantCount } : {}),
  };

  if (isFollowedChat && !isMentioned) {
    await sendToAgent(env, payload);
    return;
  }

  await handleTelegramMessage(ctx.chat.id, payload);
});

bot.on(message("photo"), async (ctx) => {
  if (ctx.message.from.is_bot) return;

  const isDM = ctx.chat.type === "private";
  const isFollowedChat = !isDM && followedChatIdSet.has(String(ctx.chat.id));

  if (!isDM && !isFollowedChat) return;

  const content: ContentPart[] = [];

  const caption = ctx.message.caption;
  if (caption) content.push({ type: "text", text: caption });

  const photos = ctx.message.photo;
  const largest = photos[photos.length - 1];
  try {
    const fileUrl = await ctx.telegram.getFileLink(largest.file_id);
    const res = await fetch(fileUrl.href);
    if (!res.ok) {
      console.error(`Failed to download photo: HTTP ${res.status}`);
    } else {
      const buffer = Buffer.from(await res.arrayBuffer());
      content.push({
        type: "image",
        media_type: "image/jpeg",
        data: buffer.toString("base64"),
      });
    }
  } catch (err) {
    console.error(`Failed to download photo: ${err}`);
  }

  if (content.length === 0) return;

  const senderName =
    ctx.message.from.first_name +
    (ctx.message.from.last_name ? ` ${ctx.message.from.last_name}` : "");
  const chatTitle = "title" in ctx.chat ? ctx.chat.title : undefined;

  let participantCount: number | undefined = isDM ? 2 : undefined;
  if (!isDM) {
    try {
      participantCount = await ctx.telegram.getChatMembersCount(ctx.chat.id);
    } catch (err) {
      console.warn(`Failed to get member count for chat ${ctx.chat.id}: ${err}`);
    }
  }

  const channelSlug = isDM
    ? buildChannelSlug("telegram", {
        isDM: true,
        senderName: ctx.message.from.username ?? ctx.message.from.first_name,
      })
    : buildChannelSlug("telegram", {
        channelName: chatTitle ?? String(ctx.chat.id),
      });

  if (env.agentDir) {
    writeChannelEntry(env.agentDir, channelSlug, {
      platformId: String(ctx.chat.id),
      platform: "telegram",
      name: chatTitle,
      type: isDM ? "dm" : "channel",
    });
  }

  const payload: AgentPayload = {
    content,
    channel: channelSlug,
    sender: senderName,
    platform: "Telegram",
    ...(isDM ? { isDM: true } : {}),
    ...(chatTitle ? { channelName: chatTitle } : {}),
    ...(participantCount ? { participantCount } : {}),
  };

  if (isFollowedChat) {
    await sendToAgent(env, payload);
    return;
  }

  await handleTelegramMessage(ctx.chat.id, payload);
});

async function handleTelegramMessage(chatId: number, payload: AgentPayload) {
  const typingInterval = setInterval(() => {
    bot.telegram.sendChatAction(chatId, "typing").catch(() => {});
  }, TYPING_INTERVAL_MS);
  bot.telegram.sendChatAction(chatId, "typing").catch(() => {});

  try {
    await sendToAgent(env, payload);
  } finally {
    clearInterval(typingInterval);
  }
}

bot
  .launch()
  .then(() => {
    console.log(`Connected to Telegram as @${bot.botInfo?.username}`);
    console.log(`Bridging to agent: ${env.agentName} via ${env.baseUrl}/message`);
    if (followedChatIds.length > 0) {
      console.log(`Following chats: ${followedChatIds.join(", ")}`);
    }
  })
  .catch((err) => {
    console.error("Failed to start Telegram connector:", err);
    process.exit(1);
  });

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
