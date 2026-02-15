import { userInfo } from "node:os";
import { getChannelDriver } from "../lib/channels.js";
import { daemonFetch } from "../lib/daemon-client.js";
import { parseArgs } from "../lib/parse-args.js";
import { parseTarget } from "../lib/parse-target.js";
import { readStdin } from "../lib/read-stdin.js";
import { resolveAgentName } from "../lib/resolve-agent-name.js";

export async function run(args: string[]) {
  const { positional, flags } = parseArgs(args, {
    agent: { type: "string" },
  });

  const target = positional[0];
  const message = positional[1] ?? (await readStdin());

  if (!target || !message) {
    console.error('Usage: volute send <target> "<message>" [--agent <name>]');
    console.error('       echo "message" | volute send <target> [--agent <name>]');
    console.error("");
    console.error("Examples:");
    console.error('  volute send @other-agent "hello"');
    console.error('  volute send animal-chat "hello everyone"');
    console.error('  volute send discord:server/channel "hello"');
    process.exit(1);
  }

  const parsed = parseTarget(target);
  const driver = getChannelDriver(parsed.platform);
  if (!driver) {
    console.error(`No driver for platform: ${parsed.platform}`);
    process.exit(1);
  }

  let channelUri = parsed.uri;

  if (parsed.isDM && parsed.platform === "volute") {
    // For volute DMs (@target), create/find conversation via the volute driver
    const targetName = parsed.identifier.slice(1); // strip @
    const agentSelf = process.env.VOLUTE_AGENT;
    const sender = agentSelf || userInfo().username;

    if (!driver.createConversation) {
      console.error("Volute driver does not support creating conversations");
      process.exit(1);
    }

    const env: Record<string, string> = {
      VOLUTE_AGENT: targetName,
      VOLUTE_SENDER: sender,
    };

    try {
      channelUri = await driver.createConversation(env, [sender]);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }

    // Send using the target agent's context
    try {
      await driver.send(env, channelUri, message);
      console.log("Message sent.");
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }

    // Persist outgoing to agent_messages if sender is a registered agent
    if (agentSelf) {
      try {
        await daemonFetch(`/api/agents/${encodeURIComponent(agentSelf)}/history`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ channel: channelUri, content: message }),
        });
      } catch (err) {
        console.error(`Failed to persist to history: ${err instanceof Error ? err.message : err}`);
      }
    }
  } else {
    // For all other targets, send through the daemon channel API
    const agentName = resolveAgentName(flags);

    const res = await daemonFetch(`/api/agents/${encodeURIComponent(agentName)}/channels/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform: parsed.platform, uri: channelUri, message }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: "Unknown error" }));
      console.error((body as { error: string }).error);
      process.exit(1);
    }
    console.log("Message sent.");
  }
}
