import { Input, Telegraf } from "telegraf";
import { message } from "telegraf/filters";
import {
  type AgentPayload,
  type ContentPart,
  fireAndForget,
  handleAgentMessage,
  loadEnv,
  loadFollowedChannels,
  splitMessage,
} from "./sdk.js";

const TELEGRAM_MAX_LENGTH = 4096;
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

  const payload: AgentPayload = {
    content,
    channel: `telegram:${ctx.chat.id}`,
    sender: senderName,
    platform: "Telegram",
    ...(isDM ? { isDM: true } : {}),
    ...(chatTitle ? { channelName: chatTitle } : {}),
    ...(participantCount ? { participantCount } : {}),
  };

  if (isFollowedChat && !isMentioned) {
    await fireAndForget(env, payload);
    return;
  }

  await handleTelegramMessage(
    ctx.chat.id,
    payload,
    (text) => ctx.reply(text),
    (source) => ctx.replyWithPhoto(source),
  );
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

  const payload: AgentPayload = {
    content,
    channel: `telegram:${ctx.chat.id}`,
    sender: senderName,
    platform: "Telegram",
    ...(isDM ? { isDM: true } : {}),
    ...(chatTitle ? { channelName: chatTitle } : {}),
    ...(participantCount ? { participantCount } : {}),
  };

  if (isFollowedChat) {
    await fireAndForget(env, payload);
    return;
  }

  await handleTelegramMessage(
    ctx.chat.id,
    payload,
    (text) => ctx.reply(text),
    (source) => ctx.replyWithPhoto(source),
  );
});

async function handleTelegramMessage(
  chatId: number,
  payload: AgentPayload,
  reply: (text: string) => Promise<unknown>,
  replyWithPhoto: (source: ReturnType<typeof Input.fromBuffer>) => Promise<unknown>,
) {
  const typingInterval = setInterval(() => {
    bot.telegram.sendChatAction(chatId, "typing").catch(() => {});
  }, TYPING_INTERVAL_MS);
  bot.telegram.sendChatAction(chatId, "typing").catch(() => {});

  try {
    await handleAgentMessage(env, payload, {
      onFlush: async (text, images) => {
        for (const img of images) {
          try {
            await replyWithPhoto(Input.fromBuffer(Buffer.from(img.data, "base64")));
          } catch (err) {
            console.error(`Failed to send image: ${err}`);
          }
        }

        if (!text) return;

        const chunks = splitMessage(text, TELEGRAM_MAX_LENGTH);
        for (const chunk of chunks) {
          try {
            await reply(chunk);
          } catch (err) {
            console.error(`Failed to send message: ${err}`);
          }
        }
      },
      onError: async (msg) => {
        await reply(msg).catch(() => {});
      },
    });
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
