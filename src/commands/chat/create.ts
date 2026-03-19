import { daemonFetch } from "../../lib/daemon-client.js";
import { parseArgs } from "../../lib/parse-args.js";
import { resolveMindName } from "../../lib/resolve-mind-name.js";

export async function run(args: string[]) {
  const { flags } = parseArgs(args, {
    mind: { type: "string" },
    participants: { type: "string" },
    name: { type: "string" },
    channel: { type: "string" },
  });

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
}
