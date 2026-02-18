import { userInfo } from "node:os";
import { getClient, urlOf } from "../lib/api-client.js";
import { getChannelDriver } from "../lib/channels.js";
import { daemonFetch } from "../lib/daemon-client.js";
import { parseArgs } from "../lib/parse-args.js";
import { parseTarget } from "../lib/parse-target.js";
import { readStdin } from "../lib/read-stdin.js";
import { findMind } from "../lib/registry.js";
import { resolveMindName } from "../lib/resolve-mind-name.js";

export async function run(args: string[]) {
  const { positional, flags } = parseArgs(args, {
    mind: { type: "string" },
  });

  const target = positional[0];
  const message = positional[1] ?? (await readStdin());

  if (!target || !message) {
    console.error('Usage: volute send <target> "<message>" [--mind <name>]');
    console.error('       echo "message" | volute send <target> [--mind <name>]');
    console.error("");
    console.error("Examples:");
    console.error('  volute send @other-mind "hello"');
    console.error('  volute send animal-chat "hello everyone"');
    console.error('  volute send discord:server/channel "hello"');
    process.exit(1);
  }

  // Catch attempts to reply to system messages (with or without @)
  if (target === "system" || target === "@system") {
    console.error(
      "Can't send to system — system messages are automated.\n" +
        'To reply to a person, use their username from the message prefix (e.g. volute send @username "msg").',
    );
    process.exit(1);
  }

  let parsed = parseTarget(target);

  // If bare name matches a registered mind, treat as a DM (e.g. "sprout" → "@sprout")
  if (!parsed.isDM && parsed.platform === "volute" && findMind(parsed.identifier)) {
    parsed = {
      platform: "volute",
      identifier: `@${parsed.identifier}`,
      uri: `volute:@${parsed.identifier}`,
      isDM: true,
    };
  }

  const driver = getChannelDriver(parsed.platform);
  if (!driver) {
    console.error(`No driver for platform: ${parsed.platform}`);
    process.exit(1);
  }

  let channelUri = parsed.uri;

  if (parsed.isDM && parsed.platform === "volute") {
    // For volute DMs (@target), create/find conversation via the volute driver
    const targetName = parsed.identifier.slice(1); // strip @
    const mindSelf = process.env.VOLUTE_MIND;
    const sender = mindSelf || userInfo().username;

    if (!driver.createConversation) {
      console.error("Volute driver does not support creating conversations");
      process.exit(1);
    }

    // When a mind sends to a non-mind (human), use the sender mind's context
    // so the conversation is created under the mind (humans aren't in the registry).
    const targetIsMind = !!findMind(targetName);
    const contextMind = mindSelf && !targetIsMind ? mindSelf : targetName;
    const participants = mindSelf && !targetIsMind ? [targetName] : [sender];

    const env: Record<string, string> = {
      VOLUTE_MIND: contextMind,
      VOLUTE_SENDER: sender,
    };

    try {
      channelUri = await driver.createConversation(env, participants);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }

    try {
      await driver.send(env, channelUri, message);
      console.log("Message sent.");
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }

    // Persist outgoing to mind_messages if sender is a registered mind
    if (mindSelf) {
      try {
        const client = getClient();
        await daemonFetch(
          urlOf(client.api.minds[":name"].history.$url({ param: { name: mindSelf } })),
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ channel: channelUri, content: message }),
          },
        );
      } catch (err) {
        console.error(`Failed to persist to history: ${err instanceof Error ? err.message : err}`);
      }
    }
  } else {
    // For all other targets, send through the daemon channel API
    const mindName = resolveMindName(flags);

    const client = getClient();
    const res = await daemonFetch(
      urlOf(client.api.minds[":name"].channels.send.$url({ param: { name: mindName } })),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform: parsed.platform, uri: channelUri, message }),
      },
    );
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: "Unknown error" }));
      console.error((body as { error: string }).error);
      process.exit(1);
    }
    console.log("Message sent.");

    // Persist outgoing to mind_messages if sender is a registered mind
    if (process.env.VOLUTE_MIND) {
      try {
        await daemonFetch(
          urlOf(client.api.minds[":name"].history.$url({ param: { name: mindName } })),
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ channel: channelUri, content: message }),
          },
        );
      } catch (err) {
        console.error(`Failed to persist to history: ${err instanceof Error ? err.message : err}`);
      }
    }
  }
}
