const API_BASE = "https://discord.com/api/v10";

export async function read(
  env: Record<string, string>,
  channelId: string,
  limit: number,
): Promise<string> {
  const token = env.DISCORD_TOKEN;
  if (!token) throw new Error("DISCORD_TOKEN not set");
  const res = await fetch(`${API_BASE}/channels/${channelId}/messages?limit=${limit}`, {
    headers: { Authorization: `Bot ${token}` },
  });
  if (!res.ok) {
    throw new Error(`Discord API error: ${res.status} ${res.statusText}`);
  }
  const messages = (await res.json()) as {
    author: { username: string };
    content: string;
  }[];
  return messages
    .reverse()
    .map((m) => `${m.author.username}: ${m.content}`)
    .join("\n");
}

export async function send(
  env: Record<string, string>,
  channelId: string,
  message: string,
): Promise<void> {
  const token = env.DISCORD_TOKEN;
  if (!token) throw new Error("DISCORD_TOKEN not set");
  const res = await fetch(`${API_BASE}/channels/${channelId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ content: message }),
  });
  if (!res.ok) {
    throw new Error(`Discord API error: ${res.status} ${res.statusText}`);
  }
}
