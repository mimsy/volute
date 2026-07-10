import { getClient, urlOf } from "../lib/api-client.js";
import { command } from "../lib/command.js";
import { daemonFetch } from "../lib/daemon-client.js";
import { resolveMindName } from "../lib/resolve-mind-name.js";
import { relativeAge } from "./mind-list.js";

type ContactRow = {
  channel: string | null;
  last_at: string;
  last_inbound_at: string | null;
  last_outbound_at: string | null;
  message_count: number;
  last_sender: string | null;
};

type ContactsResponse = {
  hours: number;
  contacts: ContactRow[];
};

const cmd = command({
  name: "volute mind contacts",
  description: "Who a mind has recently been in contact with (freshness-independent)",
  flags: {
    mind: { type: "string", description: "Mind name" },
    hours: { type: "string", description: "Lookback window in hours (default 48)" },
  },
  examples: ["volute mind contacts --mind atlas", "volute mind contacts atlas --hours 24"],
  run: async ({ flags }) => {
    const name = resolveMindName(flags);
    const client = getClient();

    const url = client.api.minds[":name"].history.contacts.$url({ param: { name } });
    if (flags.hours) url.searchParams.set("hours", flags.hours);

    const res = await daemonFetch(urlOf(url));
    if (!res.ok) {
      let errorMsg = `Failed to get contacts: ${res.status}`;
      try {
        const data = (await res.json()) as { error?: string };
        if (data.error) errorMsg = data.error;
      } catch {}
      console.error(errorMsg);
      process.exit(1);
    }

    const { hours, contacts } = (await res.json()) as ContactsResponse;

    if (contacts.length === 0) {
      console.log(`No contacts for ${name} in the last ${hours}h.`);
      return;
    }

    console.log(`Recent contacts for ${name} (last ${hours}h):`);
    for (const row of contacts) {
      const channel = row.channel ?? "(unknown)";
      const ago = relativeAge(row.last_at);
      const last = ago ? `${ago} ago` : row.last_at;
      const who = row.last_sender ? `, with ${row.last_sender}` : "";
      console.log(`  ${channel} — last ${last}, ${row.message_count} msg${who}`);
    }
  },
});

export const run = cmd.execute;
