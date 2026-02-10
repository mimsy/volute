const API_BASE = "https://slack.com/api";

function requireToken(env: Record<string, string>): string {
  const token = env.SLACK_BOT_TOKEN;
  if (!token) throw new Error("SLACK_BOT_TOKEN not set");
  return token;
}

async function slackApi(
  token: string,
  method: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const res = await fetch(`${API_BASE}/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Slack API HTTP error: ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as { ok: boolean; error?: string };
  if (!data.ok) {
    throw new Error(`Slack API error: ${data.error}`);
  }
  return data;
}

export async function read(
  env: Record<string, string>,
  channelId: string,
  limit: number,
): Promise<string> {
  const token = requireToken(env);
  const data = (await slackApi(token, "conversations.history", {
    channel: channelId,
    limit,
  })) as {
    messages: { user?: string; bot_id?: string; text: string }[];
  };
  return data.messages
    .reverse()
    .map((m) => `${m.user ?? m.bot_id ?? "unknown"}: ${m.text}`)
    .join("\n");
}

export async function send(
  env: Record<string, string>,
  channelId: string,
  message: string,
): Promise<void> {
  const token = requireToken(env);
  await slackApi(token, "chat.postMessage", {
    channel: channelId,
    text: message,
  });
}
