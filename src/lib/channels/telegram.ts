import { splitMessage } from "../../connectors/sdk.js";
import { type ImageAttachment, resolveChannelId } from "../channels.js";

const TELEGRAM_MAX_LENGTH = 4096;

const API_BASE = "https://api.telegram.org";

function requireToken(env: Record<string, string>): string {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN not set");
  return token;
}

export async function read(
  _env: Record<string, string>,
  _channelSlug: string,
  _limit: number,
): Promise<string> {
  throw new Error(
    "Telegram Bot API does not support reading chat history. Use volute send instead.",
  );
}

export async function send(
  env: Record<string, string>,
  channelSlug: string,
  message: string,
  images?: ImageAttachment[],
): Promise<void> {
  const token = requireToken(env);
  const chatId = resolveChannelId(env, channelSlug);

  if (images?.length) {
    for (let i = 0; i < images.length; i++) {
      const img = images[i];
      const ext = img.media_type.split("/")[1] || "png";
      const form = new FormData();
      form.append("chat_id", chatId);
      form.append(
        "photo",
        new Blob([Buffer.from(img.data, "base64")], { type: img.media_type }),
        `image.${ext}`,
      );
      // Attach caption to the first image only (Telegram max 1024 chars)
      if (i === 0 && message) {
        form.append("caption", message.slice(0, 1024));
      }

      const res = await fetch(`${API_BASE}/bot${token}/sendPhoto`, {
        method: "POST",
        body: form,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`Telegram API error: ${res.status} ${body}`);
      }
    }
    return;
  }

  const chunks = splitMessage(message, TELEGRAM_MAX_LENGTH);
  for (let i = 0; i < chunks.length; i++) {
    const res = await fetch(`${API_BASE}/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: chunks[i] }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const partial = i > 0 ? ` (${i}/${chunks.length} chunks were already sent)` : "";
      throw new Error(`Telegram API error: ${res.status} ${body}${partial}`);
    }
  }
}

export async function listConversations(): Promise<never> {
  throw new Error(
    "Telegram Bot API does not support listing conversations. Users must message the bot first.",
  );
}

export async function listUsers(): Promise<never> {
  throw new Error(
    "Telegram Bot API does not support listing users. Users must message the bot first.",
  );
}

export async function createConversation(): Promise<never> {
  throw new Error(
    "Telegram Bot API does not support creating conversations. Users must message the bot first.",
  );
}
