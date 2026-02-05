const API_BASE = "https://discord.com/api/v10";

export async function read(token: string, channelId: string, limit: number): Promise<string> {
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

export async function send(token: string, channelId: string, message: string): Promise<void> {
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
