import { formatSuggestions } from "@volute/daemon/lib/delivery/delivery-manager.js";
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
    console.log(
      `\nQuote the channel — an unquoted #name is a comment to the shell.\n` +
        `  volute chat channels peek "<channel>"     read what's held\n` +
        `  volute chat channels accept "<channel>"   start hearing it\n` +
        `  volute chat channels decline "<channel>"  opt out`,
    );
  },
});

const channelsDeclineCmd = command({
  name: "volute chat channels decline",
  description: "Decline an unrouted channel: stop invites and archive its held backlog",
  args: [{ name: "channel", required: true, description: 'Channel to decline (e.g. "#bardo")' }],
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

const channelsAcceptCmd = command({
  name: "volute chat channels accept",
  description: "Accept an unrouted channel: add a routing rule and deliver its held backlog",
  args: [{ name: "channel", required: true, description: 'Channel to accept (e.g. "#bardo")' }],
  flags: {
    mind: { type: "string", description: "Mind name" },
    thread: { type: "string", description: "Thread to route it to (default: one per channel)" },
  },
  run: async ({ args, flags }) => {
    const mind = resolveMindName(flags);
    const channel = args.channel!;

    const res = await daemonFetch(`/api/minds/${encodeURIComponent(mind)}/gates/accept`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel, thread: flags.thread }),
    });

    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      console.error(data.error ?? `Failed to accept channel: ${res.status}`);
      process.exit(1);
    }

    const data = (await res.json()) as {
      ruleAdded: boolean;
      thread: string;
      released: number;
      archived: number;
      known: boolean;
    };
    const note = data.ruleAdded ? "" : " (rule already existed)";
    console.log(
      `Accepted ${channel} → thread ${data.thread}${note}; released ${data.released} held message(s).`,
    );
    // Don't let "Accepted X ... released 0" read as a join when nothing by that name is
    // known. The rule is real and will route future traffic, but if the name is wrong it
    // will route nothing, forever, and silence is indistinguishable from a quiet channel.
    if (!data.known) {
      console.log(
        `Note: no channel named ${channel} is known here and nothing was held for it. ` +
          `The rule will route future messages if the name is right — ` +
          `check it against 'volute chat channels list'.`,
      );
    }
    if (data.archived > 0) {
      console.log(
        `${data.archived} older message(s) were not delivered — read them with ` +
          `'volute chat channels peek "${channel}"'.`,
      );
    }
  },
});

const channelsPeekCmd = command({
  name: "volute chat channels peek",
  description: "Read the messages held on an unrouted channel without accepting it",
  args: [{ name: "channel", required: true, description: 'Channel to peek at (e.g. "#bardo")' }],
  flags: {
    mind: { type: "string", description: "Mind name" },
  },
  run: async ({ args, flags }) => {
    const mind = resolveMindName(flags);
    const channel = args.channel!;

    const res = await daemonFetch(
      `/api/minds/${encodeURIComponent(mind)}/gates/peek?channel=${encodeURIComponent(channel)}`,
    );

    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      console.error(data.error ?? `Failed to read held messages: ${res.status}`);
      process.exit(1);
    }

    const data = (await res.json()) as {
      count: number;
      shown: number;
      suggestions?: string[];
      messages: { sender: string | null; content: string; createdAt: string; status: string }[];
    };

    if (data.count === 0) {
      console.log(`No held messages on ${channel}.`);
      if (data.suggestions?.length) {
        console.log(
          `No channel by that name exists — did you mean ${formatSuggestions(data.suggestions)}?`,
        );
      }
      return;
    }

    if (data.shown < data.count) {
      console.log(`Showing the ${data.shown} most recent of ${data.count} held message(s).\n`);
    }
    for (const m of data.messages) {
      const mark = m.status === "archived" ? " (archived)" : "";
      console.log(`[${m.createdAt}] ${m.sender ?? "unknown"}${mark}: ${m.content}`);
    }
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
    peek: {
      description: "Read messages held on an unrouted channel",
      run: channelsPeekCmd.execute,
    },
    accept: {
      description: "Accept an unrouted channel and deliver its held backlog",
      run: channelsAcceptCmd.execute,
    },
    decline: {
      description: "Decline an unrouted channel",
      run: channelsDeclineCmd.execute,
    },
  },
  footer: "Use --mind <name> or VOLUTE_MIND to identify the mind.",
});

export const run = cmd.execute;
