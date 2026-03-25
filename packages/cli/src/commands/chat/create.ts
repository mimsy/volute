import { command } from "../../lib/command.js";
import { daemonFetch } from "../../lib/daemon-client.js";
import { resolveMindName } from "../../lib/resolve-mind-name.js";

const cmd = command({
  name: "volute chat create",
  description: "Create a conversation",
  flags: {
    mind: { type: "string", description: "Mind name" },
    participants: { type: "string", description: "Comma-separated participant names (required)" },
    name: { type: "string", description: "Conversation title" },
    channel: { type: "string", description: "Channel name (required for 3+ participants)" },
  },
  async run({ flags }) {
    if (!flags.participants) {
      console.error(
        'Usage: volute chat create --participants u1,u2 [--name "..."] [--channel <name>] [--mind <name>]',
      );
      process.exit(1);
    }

    const mindName = resolveMindName(flags);
    const participants = flags.participants.split(",").map((p) => p.trim());

    // Reject group DMs — require --channel for 3+ participants
    if (participants.length > 2 && !flags.channel) {
      console.error("Use --channel <name> for multi-participant conversations");
      process.exit(1);
    }

    if (flags.channel) {
      // Create a channel via the channels API
      const res = await daemonFetch("/api/v1/channels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: flags.channel,
          participantNames: participants,
        }),
      });

      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        console.error(data.error ?? `Failed to create channel: ${res.status}`);
        process.exit(1);
      }

      const conv = (await res.json()) as { id: string };
      console.log(`Created channel #${flags.channel}: ${conv.id}`);
    } else {
      const res = await daemonFetch(`/api/minds/${encodeURIComponent(mindName)}/conversations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          participantNames: participants,
          title: flags.name,
        }),
      });

      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        console.error(data.error ?? `Failed to create conversation: ${res.status}`);
        process.exit(1);
      }

      const conv = (await res.json()) as { id: string };
      console.log(`Created conversation: ${conv.id}`);
    }
  },
});

export const run = cmd.execute;
