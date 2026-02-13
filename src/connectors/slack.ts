import { App } from "@slack/bolt";
import {
  buildChannelSlug,
  type ContentPart,
  loadEnv,
  loadFollowedChannels,
  onShutdown,
  sendToAgent,
  writeChannelEntry,
} from "./sdk.js";

const env = loadEnv();

const botToken = process.env.SLACK_BOT_TOKEN;
const appToken = process.env.SLACK_APP_TOKEN;

if (!botToken || !appToken) {
  console.error("Missing required env vars: SLACK_BOT_TOKEN, SLACK_APP_TOKEN");
  process.exit(1);
}

const followedChannelNames = loadFollowedChannels(env, "slack");
const followedChannelIds = new Set<string>();

const app = new App({
  token: botToken,
  socketMode: true,
  appToken,
});

let botUserId: string | undefined;
let serverName: string | undefined;

app.message(async ({ message }) => {
  if (message.subtype) return;
  if (!("user" in message) || !("text" in message)) return;
  if ("bot_id" in message && message.bot_id) return;

  const isDM = message.channel_type === "im" || message.channel_type === "mpim";
  const isMentioned = !isDM && botUserId && message.text?.includes(`<@${botUserId}>`);
  const isFollowedChannel = !isDM && followedChannelIds.has(message.channel);

  if (!isDM && !isMentioned && !isFollowedChannel) return;

  let text = message.text ?? "";
  if (isMentioned && botUserId) {
    text = text.replace(new RegExp(`<@${botUserId}>`, "g"), "").trim();
  }

  const content: ContentPart[] = [];
  if (text) content.push({ type: "text", text });

  if ("files" in message && message.files) {
    for (const file of message.files) {
      if (!file.mimetype?.startsWith("image/") || !file.url_private) continue;
      try {
        const res = await fetch(file.url_private, {
          headers: { Authorization: `Bearer ${botToken}` },
        });
        if (!res.ok) {
          console.error(`Failed to download attachment: HTTP ${res.status}`);
          continue;
        }
        const buffer = Buffer.from(await res.arrayBuffer());
        content.push({
          type: "image",
          media_type: file.mimetype,
          data: buffer.toString("base64"),
        });
      } catch (err) {
        console.error(`Failed to download attachment: ${err}`);
      }
    }
  }

  if (content.length === 0) return;

  let channelName: string | undefined;
  let numMembers: number | undefined;
  // Fetch channel info for non-1:1 DMs (includes mpim group DMs and channels)
  if (message.channel_type !== "im") {
    try {
      const info = (await app.client.conversations.info({
        channel: message.channel,
      })) as { channel?: { name?: string; num_members?: number } };
      channelName = info.channel?.name;
      numMembers = info.channel?.num_members;
    } catch (err) {
      console.warn(`Failed to get channel info: ${err}`);
    }
  }

  let senderName = message.user;
  let senderUsername = message.user;
  try {
    const userInfo = (await app.client.users.info({
      user: message.user,
    })) as { user?: { name?: string; profile?: { display_name?: string; real_name?: string } } };
    senderName =
      userInfo.user?.profile?.display_name || userInfo.user?.profile?.real_name || message.user;
    senderUsername = userInfo.user?.name ?? message.user;
  } catch (err) {
    console.warn(`Failed to get user info: ${err}`);
  }

  const channelKey = isDM
    ? buildChannelSlug("slack", {
        isDM: true,
        senderName: senderUsername,
      })
    : buildChannelSlug("slack", {
        channelName: channelName ?? message.channel,
        serverName,
      });

  if (env.agentDir) {
    writeChannelEntry(env.agentDir, channelKey, {
      platformId: message.channel,
      platform: "slack",
      name: channelName ? `#${channelName}` : undefined,
      server: serverName,
      type: isDM ? "dm" : "channel",
    });
  }

  const participantCount = message.channel_type === "im" ? 2 : numMembers;
  const payload = {
    content,
    channel: channelKey,
    sender: senderName,
    platform: "Slack",
    ...(isDM ? { isDM: true } : {}),
    ...(channelName ? { channelName } : {}),
    ...(serverName ? { serverName } : {}),
    ...(participantCount ? { participantCount } : {}),
  };

  if (isFollowedChannel && !isMentioned) {
    await sendToAgent(env, payload);
    return;
  }

  await sendToAgent(env, payload);
});

async function start() {
  await app.start();

  const auth = (await app.client.auth.test()) as { user_id?: string; team?: string };
  if (!auth.user_id) {
    throw new Error("auth.test succeeded but returned no user_id");
  }
  botUserId = auth.user_id;
  serverName = auth.team;
  console.log(
    `Connected to Slack as bot user ${botUserId}${serverName ? ` in ${serverName}` : ""}`,
  );

  console.log(`Bridging to agent: ${env.agentName} via ${env.baseUrl}/message`);

  if (followedChannelNames.length > 0) {
    try {
      let cursor: string | undefined;
      do {
        const result = (await app.client.conversations.list({
          types: "public_channel,private_channel",
          limit: 200,
          ...(cursor ? { cursor } : {}),
        })) as {
          channels?: { id: string; name: string }[];
          response_metadata?: { next_cursor?: string };
        };
        for (const ch of result.channels ?? []) {
          if (followedChannelNames.includes(ch.name)) {
            followedChannelIds.add(ch.id);
            console.log(`Following #${ch.name} (${ch.id})`);
          }
        }
        cursor = result.response_metadata?.next_cursor || undefined;
      } while (cursor);
    } catch (err) {
      console.error(`Failed to resolve channel names: ${err}`);
    }
    if (followedChannelIds.size === 0 && followedChannelNames.length > 0) {
      console.warn(`No channels found matching: ${followedChannelNames.join(", ")}`);
    }
  }
}

onShutdown(async () => {
  await app.stop();
});

start().catch((err) => {
  console.error("Failed to start Slack connector:", err);
  process.exit(1);
});
