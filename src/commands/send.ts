import { userInfo } from "node:os";
import { getChannelDriver } from "../lib/channels.js";
import { daemonFetch } from "../lib/daemon-client.js";
import { readStdin } from "../lib/read-stdin.js";

export async function run(args: string[]) {
  const name = args[0];
  const message = args[1] ?? (await readStdin());

  if (!name || !message) {
    console.error('Usage: volute message send <name> "<message>"');
    console.error('       echo "message" | volute message send <name>');
    process.exit(1);
  }

  const agentSelf = process.env.VOLUTE_AGENT;
  const sender = agentSelf || userInfo().username;

  const driver = getChannelDriver("volute");
  if (!driver?.createConversation) {
    console.error("Volute driver not available");
    process.exit(1);
  }

  const env: Record<string, string> = { VOLUTE_AGENT: name, VOLUTE_SENDER: sender };

  // Create or reuse DM conversation
  let conversationId: string;
  try {
    conversationId = await driver.createConversation(env, [sender]);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  // Send message and wait for completion
  try {
    await driver.send(env, conversationId, message);
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
        body: JSON.stringify({ channel: conversationId, content: message }),
      });
    } catch (err) {
      console.error(`Failed to persist to history: ${err instanceof Error ? err.message : err}`);
    }
  }
}
