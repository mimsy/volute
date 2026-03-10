/**
 * Telegram bridge — connects Telegram to Volute conversations via the bridge API.
 * System-level: one bot per installation, not per-mind.
 */
import { Telegraf } from "telegraf";
import { message } from "telegraf/filters";
import { slugify } from "../lib/slugify.js";
import { type ContentPart, loadBridgeEnv, sendToBridge } from "./bridge-sdk.js";

const env = loadBridgeEnv();

const botToken = process.env.TELEGRAM_BOT_TOKEN;
if (!botToken) {
  console.error("Missing required env var: TELEGRAM_BOT_TOKEN");
  process.exit(1);
}

const TYPING_INTERVAL_MS = 5000;
const bot = new Telegraf(botToken);

bot.on(message("text"), async (ctx) => {
  if (ctx.message.from.is_bot) return;

  const isDM = ctx.chat.type === "private";
  const botUsername = ctx.botInfo.username;

  let text = ctx.message.text;
  if (!isDM && botUsername) {
    const isMentioned = ctx.message.entities?.some(
      (e) =>
        e.type === "mention" &&
        ctx.message.text.substring(e.offset, e.offset + e.length) === `@${botUsername}`,
    );
    if (isMentioned) {
      text = text.replace(new RegExp(`@${botUsername}`, "g"), "").trim();
    }
  }

  const content: ContentPart[] = [];
  if (text) content.push({ type: "text", text });
  if (content.length === 0) return;

  const displayName =
    ctx.message.from.first_name +
    (ctx.message.from.last_name ? ` ${ctx.message.from.last_name}` : "");
  const platformUserId = ctx.message.from.username ?? String(ctx.message.from.id);
  const chatTitle = "title" in ctx.chat ? ctx.chat.title : undefined;

  const externalChannel = isDM
    ? `@${slugify(platformUserId)}`
    : chatTitle
      ? slugify(chatTitle)
      : String(ctx.chat.id);

  if (isDM) {
    const typingInterval = setInterval(() => {
      bot.telegram.sendChatAction(ctx.chat.id, "typing").catch(() => {});
    }, TYPING_INTERVAL_MS);
    bot.telegram.sendChatAction(ctx.chat.id, "typing").catch(() => {});

    try {
      const result = await sendToBridge(env, {
        content,
        platformUserId,
        displayName,
        externalChannel,
        isDM: true,
      });
      if (!result.ok) {
        ctx.reply(result.error ?? "Failed to process message").catch(() => {});
      }
    } finally {
      clearInterval(typingInterval);
    }
  } else {
    const result = await sendToBridge(env, {
      content,
      platformUserId,
      displayName,
      externalChannel,
      isDM: false,
    });
    if (!result.ok) {
      ctx.reply(result.error ?? "Failed to process message").catch(() => {});
    }
  }
});

bot.on(message("photo"), async (ctx) => {
  if (ctx.message.from.is_bot) return;

  const isDM = ctx.chat.type === "private";
  const content: ContentPart[] = [];

  const caption = ctx.message.caption;
  if (caption) content.push({ type: "text", text: caption });

  const photos = ctx.message.photo;
  const largest = photos[photos.length - 1];
  try {
    const fileUrl = await ctx.telegram.getFileLink(largest.file_id);
    const res = await fetch(fileUrl.href);
    if (res.ok) {
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

  const displayName =
    ctx.message.from.first_name +
    (ctx.message.from.last_name ? ` ${ctx.message.from.last_name}` : "");
  const platformUserId = ctx.message.from.username ?? String(ctx.message.from.id);
  const chatTitle = "title" in ctx.chat ? ctx.chat.title : undefined;

  const externalChannel = isDM
    ? `@${slugify(platformUserId)}`
    : chatTitle
      ? slugify(chatTitle)
      : String(ctx.chat.id);

  const result = await sendToBridge(env, {
    content,
    platformUserId,
    displayName,
    externalChannel,
    isDM,
  });
  if (!result.ok) {
    ctx.reply(result.error ?? "Failed to process message").catch(() => {});
  }
});

bot
  .launch()
  .then(() => {
    console.log(`Telegram bridge connected as @${bot.botInfo?.username}`);
  })
  .catch((err) => {
    console.error("Failed to start Telegram bridge:", err);
    process.exit(1);
  });

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
