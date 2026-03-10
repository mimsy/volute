/**
 * Slack bridge — connects Slack to Volute conversations via the bridge API.
 * System-level: one bot per installation, not per-mind.
 */
import { App } from "@slack/bolt";
import { slugify } from "../lib/slugify.js";
import { type ContentPart, loadBridgeEnv, onShutdown, sendToBridge } from "./bridge-sdk.js";

const env = loadBridgeEnv();

const botToken = process.env.SLACK_BOT_TOKEN;
const appToken = process.env.SLACK_APP_TOKEN;

if (!botToken || !appToken) {
  console.error("Missing required env vars: SLACK_BOT_TOKEN, SLACK_APP_TOKEN");
  process.exit(1);
}

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

  let text = message.text ?? "";
  if (!isDM && botUserId && text.includes(`<@${botUserId}>`)) {
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
        if (!res.ok) continue;
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

  // Resolve sender info
  let displayName = message.user;
  let senderUsername = message.user;
  try {
    const userInfo = (await app.client.users.info({
      user: message.user,
    })) as { user?: { name?: string; profile?: { display_name?: string; real_name?: string } } };
    displayName =
      userInfo.user?.profile?.display_name || userInfo.user?.profile?.real_name || message.user;
    senderUsername = userInfo.user?.name ?? message.user;
  } catch (err) {
    console.warn(`Failed to get user info: ${err}`);
  }

  // Resolve channel info
  let channelName: string | undefined;
  if (!isDM) {
    try {
      const info = (await app.client.conversations.info({
        channel: message.channel,
      })) as { channel?: { name?: string } };
      channelName = info.channel?.name;
    } catch (err) {
      console.warn(`Failed to get channel info: ${err}`);
    }
  }

  const externalChannel = isDM
    ? `@${slugify(senderUsername)}`
    : channelName && serverName
      ? `${slugify(serverName)}/${slugify(channelName)}`
      : message.channel;

  const result = await sendToBridge(env, {
    content,
    platformUserId: senderUsername,
    displayName,
    externalChannel,
    isDM,
  });

  if (!result.ok) {
    app.client.chat
      .postMessage({
        channel: message.channel,
        text: result.error ?? "Failed to process message",
      })
      .catch((err) => {
        console.warn(`[slack-bridge] failed to send error reply: ${err}`);
      });
  }
});

async function start() {
  await app.start();

  const auth = (await app.client.auth.test()) as { user_id?: string; team?: string };
  if (!auth.user_id) {
    throw new Error("auth.test succeeded but returned no user_id");
  }
  botUserId = auth.user_id;
  serverName = auth.team;
  console.log(`Slack bridge connected as ${botUserId}${serverName ? ` in ${serverName}` : ""}`);
}

onShutdown(async () => {
  await app.stop();
});

start().catch((err) => {
  console.error("Failed to start Slack bridge:", err);
  process.exit(1);
});
