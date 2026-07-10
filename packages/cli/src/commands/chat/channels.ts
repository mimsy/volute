import { command, subcommands } from "../../lib/command.js";
import { daemonFetch } from "../../lib/daemon-client.js";
import { resolveMindName } from "../../lib/resolve-mind-name.js";

const channelsListCmd = command({
  name: "volute chat channels",
  description: "List unrouted (gated) channels holding messages",
  args: [],
  flags: {
    mind: { type: "string", description: "Mind name" },
  },
  run: async ({ flags }) => {
    const mind = resolveMindName(flags);

    const res = await daemonFetch(`/api/minds/${encodeURIComponent(mind)}/delivery/pending`);
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      console.error(data.error ?? `Failed to list gated channels: ${res.status}`);
      process.exit(1);
    }

    const pending = (await res.json()) as Array<{
      channel: string | null;
      sender: string | null;
      count: number;
      firstSeen: string;
    }>;

    if (pending.length === 0) {
      console.log("No unrouted channels holding messages.");
      return;
    }

    const chW = Math.max(7, ...pending.map((p) => (p.channel ?? "unknown").length));
    console.log(`${"CHANNEL".padEnd(chW)}  HELD  SINCE`);
    for (const p of pending) {
      console.log(
        `${(p.channel ?? "unknown").padEnd(chW)}  ${String(p.count).padStart(4)}  ${p.firstSeen}`,
      );
    }
    console.log(`\nRoute one to hear it, or 'volute chat channels decline <channel>' to opt out.`);
  },
});

const channelsDeclineCmd = command({
  name: "volute chat channels decline",
  description: "Decline an unrouted channel: stop invites and archive its held backlog",
  args: [{ name: "channel", required: true, description: "Channel to decline (e.g. #bardo)" }],
  flags: {
    mind: { type: "string", description: "Mind name" },
  },
  run: async ({ args, flags }) => {
    const mind = resolveMindName(flags);
    const channel = args.channel!;

    const res = await daemonFetch(`/api/minds/${encodeURIComponent(mind)}/gates/decline`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel }),
    });

    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      console.error(data.error ?? `Failed to decline channel: ${res.status}`);
      process.exit(1);
    }

    const data = (await res.json()) as { archived: number };
    console.log(`Declined ${channel}; archived ${data.archived} held message(s).`);
  },
});

const cmd = subcommands({
  name: "volute chat channels",
  description: "Manage unrouted (gated) channels",
  commands: {
    list: {
      description: "List unrouted channels holding messages",
      run: channelsListCmd.execute,
    },
    decline: {
      description: "Decline an unrouted channel",
      run: channelsDeclineCmd.execute,
    },
  },
  footer: "Use --mind <name> or VOLUTE_MIND to identify the mind.",
});

export const run = cmd.execute;
