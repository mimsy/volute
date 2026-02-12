import type { ChannelConversation, ChannelUser } from "../channels.js";

const API_BASE = "https://discord.com/api/v10";

function requireToken(env: Record<string, string>): string {
  const token = env.DISCORD_TOKEN;
  if (!token) throw new Error("DISCORD_TOKEN not set");
  return token;
}

async function discordGet(token: string, path: string): Promise<unknown> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bot ${token}` },
  });
  if (!res.ok) {
    throw new Error(`Discord API error: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

export async function read(
  env: Record<string, string>,
  channelId: string,
  limit: number,
): Promise<string> {
  const token = requireToken(env);
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
  const token = requireToken(env);
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

export async function listConversations(
  env: Record<string, string>,
): Promise<ChannelConversation[]> {
  const token = requireToken(env);
  const results: ChannelConversation[] = [];

  // Get guild text channels
  const guilds = (await discordGet(token, "/users/@me/guilds")) as { id: string }[];
  for (const guild of guilds) {
    const channels = (await discordGet(token, `/guilds/${guild.id}/channels`)) as {
      id: string;
      name: string;
      type: number;
    }[];
    for (const ch of channels) {
      if (ch.type !== 0) continue; // text channels only
      results.push({
        id: `discord:${ch.id}`,
        name: `#${ch.name}`,
        type: "channel",
      });
    }
  }

  // Get DM channels
  const dms = (await discordGet(token, "/users/@me/channels")) as {
    id: string;
    type: number;
    recipients?: { username: string }[];
  }[];
  for (const dm of dms) {
    const name = dm.recipients?.map((r) => r.username).join(", ") ?? "DM";
    results.push({
      id: `discord:${dm.id}`,
      name,
      type: dm.type === 1 ? "dm" : "group",
    });
  }

  return results;
}

export async function listUsers(env: Record<string, string>): Promise<ChannelUser[]> {
  const token = requireToken(env);
  const seen = new Map<string, ChannelUser>();

  const guilds = (await discordGet(token, "/users/@me/guilds")) as { id: string }[];
  for (const guild of guilds) {
    const members = (await discordGet(token, `/guilds/${guild.id}/members?limit=1000`)) as {
      user: { id: string; username: string; bot?: boolean };
    }[];
    for (const m of members) {
      if (!seen.has(m.user.id)) {
        seen.set(m.user.id, {
          id: m.user.id,
          username: m.user.username,
          type: m.user.bot ? "bot" : "human",
        });
      }
    }
  }

  return [...seen.values()];
}

export async function createConversation(
  env: Record<string, string>,
  participants: string[],
  _name?: string,
): Promise<string> {
  const token = requireToken(env);

  if (participants.length !== 1) {
    throw new Error(
      "Discord group creation not supported via bot — use threads in an existing channel",
    );
  }

  // Resolve username to user ID by searching guild members
  const allUsers = await listUsers(env);
  const target = allUsers.find((u) => u.username.toLowerCase() === participants[0].toLowerCase());
  if (!target) {
    throw new Error(`User not found: ${participants[0]}`);
  }

  const res = await fetch(`${API_BASE}/users/@me/channels`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ recipient_id: target.id }),
  });
  if (!res.ok) {
    throw new Error(`Discord API error: ${res.status} ${res.statusText}`);
  }
  const dm = (await res.json()) as { id: string };
  return dm.id;
}
