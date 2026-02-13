import { splitMessage } from "../../connectors/sdk.js";
import { resolveChannelId } from "../channels.js";

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
    "Telegram Bot API does not support reading chat history. Use volute channel send instead.",
  );
}

export async function send(
  env: Record<string, string>,
  channelSlug: string,
  message: string,
): Promise<void> {
  const token = requireToken(env);
  const chatId = resolveChannelId(env, channelSlug);
  const chunks = splitMessage(message, TELEGRAM_MAX_LENGTH);
  for (const chunk of chunks) {
    const res = await fetch(`${API_BASE}/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: chunk }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Telegram API error: ${res.status} ${body}`);
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
