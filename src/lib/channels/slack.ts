import { splitMessage, writeChannelEntry } from "../../connectors/sdk.js";
import { type ChannelConversation, type ChannelUser, resolveChannelId } from "../channels.js";
import { slugify } from "../slugify.js";

const SLACK_MAX_LENGTH = 4000;

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
  channelSlug: string,
  limit: number,
): Promise<string> {
  const token = requireToken(env);
  const channelId = resolveChannelId(env, channelSlug);
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
  channelSlug: string,
  message: string,
): Promise<void> {
  const token = requireToken(env);
  const channelId = resolveChannelId(env, channelSlug);
  const chunks = splitMessage(message, SLACK_MAX_LENGTH);
  for (let i = 0; i < chunks.length; i++) {
    try {
      await slackApi(token, "chat.postMessage", {
        channel: channelId,
        text: chunks[i],
      });
    } catch (err) {
      const partial = i > 0 ? ` (${i}/${chunks.length} chunks were already sent)` : "";
      throw new Error(`${err instanceof Error ? err.message : err}${partial}`);
    }
  }
}

export async function listConversations(
  env: Record<string, string>,
): Promise<ChannelConversation[]> {
  const token = requireToken(env);

  // Get workspace name for slug prefix
  const authData = (await slackApi(token, "auth.test", {})) as { team?: string };
  const teamName = authData.team ?? "workspace";

  const data = (await slackApi(token, "conversations.list", {
    types: "public_channel,private_channel,mpim,im",
    limit: 1000,
  })) as {
    channels: {
      id: string;
      name?: string;
      is_im?: boolean;
      is_mpim?: boolean;
      user?: string;
      num_members?: number;
    }[];
  };

  // Build user ID to username map for DMs
  const userMap = new Map<string, string>();
  const imChannels = data.channels.filter((ch) => ch.is_im && ch.user);
  if (imChannels.length > 0) {
    const users = await listUsers(env);
    for (const u of users) {
      userMap.set(u.id, u.username);
    }
  }

  return data.channels.map((ch) => {
    let type: "dm" | "group" | "channel" = "channel";
    if (ch.is_im) type = "dm";
    else if (ch.is_mpim) type = "group";

    let slug: string;
    let name: string;
    if (ch.is_im && ch.user) {
      const username = userMap.get(ch.user) ?? ch.user;
      slug = `slack:@${slugify(username)}`;
      name = username;
    } else if (ch.name) {
      slug = `slack:${slugify(teamName)}/${slugify(ch.name)}`;
      name = ch.name;
    } else {
      slug = `slack:${ch.id}`;
      name = ch.id;
    }

    return {
      id: slug,
      platformId: ch.id,
      name,
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

  const mindName = env.VOLUTE_MIND;

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

    // Get workspace name for slug
    const authData = (await slackApi(token, "auth.test", {})) as { team?: string };
    const teamName = authData.team ?? "workspace";
    const slug = `slack:${slugify(teamName)}/${slugify(name)}`;

    if (mindName) {
      writeChannelEntry(mindName, slug, {
        platformId: channelId,
        platform: "slack",
        name,
        type: "channel",
      });
    }

    return slug;
  }

  // Open a DM or group DM (idempotent for same participants)
  const openData = (await slackApi(token, "conversations.open", {
    users: ids.join(","),
  })) as { channel: { id: string } };
  const platformId = openData.channel.id;

  const slug =
    participants.length === 1
      ? `slack:@${slugify(participants[0])}`
      : `slack:@${participants.map(slugify).sort().join(",")}`;

  if (mindName) {
    writeChannelEntry(mindName, slug, {
      platformId,
      platform: "slack",
      name: participants.join(", "),
      type: participants.length === 1 ? "dm" : "group",
    });
  }

  return slug;
}
