import type { ChannelConversation, ChannelUser } from "../channels.js";

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

export async function listConversations(
  env: Record<string, string>,
): Promise<ChannelConversation[]> {
  const token = requireToken(env);
  const data = (await slackApi(token, "conversations.list", {
    types: "public_channel,private_channel,mpim,im",
    limit: 1000,
  })) as {
    channels: {
      id: string;
      name?: string;
      is_im?: boolean;
      is_mpim?: boolean;
      num_members?: number;
    }[];
  };

  return data.channels.map((ch) => {
    let type: "dm" | "group" | "channel" = "channel";
    if (ch.is_im) type = "dm";
    else if (ch.is_mpim) type = "group";
    return {
      id: `slack:${ch.id}`,
      name: ch.name ?? ch.id,
      type,
      participantCount: ch.num_members,
    };
  });
}

export async function listUsers(env: Record<string, string>): Promise<ChannelUser[]> {
  const token = requireToken(env);
  const data = (await slackApi(token, "users.list", {})) as {
    members: {
      id: string;
      name: string;
      deleted?: boolean;
      is_bot?: boolean;
    }[];
  };

  return data.members
    .filter((m) => !m.deleted)
    .map((m) => ({
      id: m.id,
      username: m.name,
      type: m.is_bot ? "bot" : "human",
    }));
}

export async function createConversation(
  env: Record<string, string>,
  participants: string[],
  name?: string,
): Promise<string> {
  const token = requireToken(env);

  // Resolve usernames to IDs
  const allUsers = await listUsers(env);
  const ids: string[] = [];
  for (const p of participants) {
    const user = allUsers.find((u) => u.username.toLowerCase() === p.toLowerCase());
    if (!user) throw new Error(`User not found: ${p}`);
    ids.push(user.id);
  }

  if (name) {
    // Create named private channel and invite participants
    const createData = (await slackApi(token, "conversations.create", {
      name,
      is_private: true,
    })) as { channel: { id: string } };
    const channelId = createData.channel.id;

    for (const userId of ids) {
      await slackApi(token, "conversations.invite", {
        channel: channelId,
        users: userId,
      });
    }
    return channelId;
  }

  // Open a DM or group DM (idempotent for same participants)
  const openData = (await slackApi(token, "conversations.open", {
    users: ids.join(","),
  })) as { channel: { id: string } };
  return openData.channel.id;
}
