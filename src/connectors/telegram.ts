import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Input, Telegraf } from "telegraf";
import { message } from "telegraf/filters";

const TELEGRAM_MAX_LENGTH = 4096;
const TYPING_INTERVAL_MS = 5000;

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
const botToken = process.env.TELEGRAM_BOT_TOKEN;

if (!agentPort || !agentName) {
  console.error("Missing required env vars: VOLUTE_AGENT_PORT, VOLUTE_AGENT_NAME");
  process.exit(1);
}

if (!botToken) {
  console.error("Missing required env var: TELEGRAM_BOT_TOKEN");
  process.exit(1);
}

const agentDir = process.env.VOLUTE_AGENT_DIR;
const daemonUrl = process.env.VOLUTE_DAEMON_URL;
const daemonToken = process.env.VOLUTE_DAEMON_TOKEN;

// Load followed chats from agent config
let followedChatIds: (string | number)[] = [];
if (agentDir) {
  const configPath = resolve(agentDir, "home/.config/volute.json");
  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, "utf-8"));
      followedChatIds = config.telegram?.chats ?? [];
    } catch (err) {
      console.warn(`Failed to load agent config: ${err}`);
    }
  }
}

const followedChatIdSet = new Set(followedChatIds.map(String));

const baseUrl = daemonUrl
  ? `${daemonUrl}/api/agents/${encodeURIComponent(agentName)}`
  : `http://127.0.0.1:${agentPort}`;

const bot = new Telegraf(botToken);

function splitMessage(text: string): string[] {
  const chunks: string[] = [];
  while (text.length > TELEGRAM_MAX_LENGTH) {
    let splitAt = text.lastIndexOf("\n", TELEGRAM_MAX_LENGTH);
    if (splitAt < TELEGRAM_MAX_LENGTH / 2) splitAt = TELEGRAM_MAX_LENGTH;
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
  chatId: number,
  chatTitle: string | undefined,
  senderName: string,
  content: ContentPart[],
) {
  const channelKey = `telegram:${chatId}`;
  try {
    const res = await fetch(`${baseUrl}/message`, {
      method: "POST",
      headers: getHeaders(),
      body: JSON.stringify({
        content,
        channel: channelKey,
        sender: senderName,
        platform: "Telegram",
        ...(chatTitle ? { channelName: chatTitle } : {}),
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
    console.error(`Failed to forward followed-chat message: ${err}`);
  }
}

async function handleAgentRequest(
  chatId: number,
  chatTitle: string | undefined,
  senderName: string,
  content: ContentPart[],
  isDM: boolean,
  reply: (text: string) => Promise<unknown>,
  replyWithPhoto: (source: ReturnType<typeof Input.fromBuffer>) => Promise<unknown>,
) {
  const typingInterval = setInterval(() => {
    bot.telegram.sendChatAction(chatId, "typing").catch(() => {});
  }, TYPING_INTERVAL_MS);
  bot.telegram.sendChatAction(chatId, "typing").catch(() => {});

  let accumulated = "";
  const pendingImages: { data: string; media_type: string }[] = [];

  async function flush() {
    const text = accumulated.trim();
    accumulated = "";
    if (!text && pendingImages.length === 0) return;

    // Send images
    for (const img of pendingImages.splice(0)) {
      try {
        await replyWithPhoto(Input.fromBuffer(Buffer.from(img.data, "base64")));
      } catch (err) {
        console.error(`Failed to send image: ${err}`);
      }
    }

    if (!text) return;

    const chunks = splitMessage(text);
    for (const chunk of chunks) {
      try {
        await reply(chunk);
      } catch (err) {
        console.error(`Failed to send message: ${err}`);
      }
    }
  }

  const channelKey = `telegram:${chatId}`;

  try {
    const res = await fetch(`${baseUrl}/message`, {
      method: "POST",
      headers: getHeaders(),
      body: JSON.stringify({
        content,
        channel: channelKey,
        sender: senderName,
        platform: "Telegram",
        ...(isDM ? { isDM: true } : {}),
        ...(chatTitle ? { channelName: chatTitle } : {}),
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`Agent returned ${res.status}: ${body}`);
      await reply(`Error: agent returned ${res.status}`).catch(() => {});
      clearInterval(typingInterval);
      return;
    }

    if (!res.body) {
      await reply("Error: no response from agent").catch(() => {});
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
    console.error(`Failed to reach agent at ${baseUrl}/message:`, err);
    const errMsg =
      err instanceof TypeError && (err as any).cause?.code === "ECONNREFUSED"
        ? "Agent is not running"
        : `Error: ${err}`;
    await reply(errMsg).catch(() => {});
  } finally {
    clearInterval(typingInterval);
  }
}

// Handle text messages
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

  // Followed chat (not a mention) → fire and forget
  if (isFollowedChat && !isMentioned) {
    await sendFireAndForget(ctx.chat.id, chatTitle, senderName, content);
    return;
  }

  await handleAgentRequest(
    ctx.chat.id,
    chatTitle,
    senderName,
    content,
    isDM,
    (text) => ctx.reply(text),
    (source) => ctx.replyWithPhoto(source),
  );
});

// Handle photo messages
bot.on(message("photo"), async (ctx) => {
  if (ctx.message.from.is_bot) return;

  const isDM = ctx.chat.type === "private";
  const isFollowedChat = !isDM && followedChatIdSet.has(String(ctx.chat.id));

  if (!isDM && !isFollowedChat) return;

  const content: ContentPart[] = [];

  // Get caption text if present
  const caption = ctx.message.caption;
  if (caption) content.push({ type: "text", text: caption });

  // Download the largest photo
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

  if (isFollowedChat) {
    await sendFireAndForget(ctx.chat.id, chatTitle, senderName, content);
    return;
  }

  await handleAgentRequest(
    ctx.chat.id,
    chatTitle,
    senderName,
    content,
    isDM,
    (text) => ctx.reply(text),
    (source) => ctx.replyWithPhoto(source),
  );
});

bot
  .launch()
  .then(() => {
    console.log(`Connected to Telegram as @${bot.botInfo?.username}`);
    console.log(`Bridging to agent: ${agentName} via ${baseUrl}/message`);
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
