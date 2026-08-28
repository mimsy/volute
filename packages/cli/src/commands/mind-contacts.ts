import { getClient, urlOf } from "../lib/api-client.js";
import { assertRange } from "../lib/assert-range.js";
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

/**
 * Refuse an `--hours` the server would silently replace.
 *
 * `GET /:name/history/contacts` clamps the lookback to 1..168. `--hours` was a *string*
 * flag, so the number validation in `parse-args.ts` never applied: `--hours 1e9` reached
 * `parseInt` as `1` and reported one hour of contacts, `--hours notanumber` reported the
 * default 48. The response line ("last 48h") names the window it used, but nothing names
 * the window that was asked for — the same species of silence as `mind history --limit`.
 */
export function assertContactsHours(hours: number | undefined): void {
  assertRange("--hours", hours, 1, 168);
}

const cmd = command({
  name: "volute mind contacts",
  description: "Who a mind has recently been in contact with (freshness-independent)",
  flags: {
    mind: { type: "string", description: "Mind name" },
    hours: { type: "number", description: "Lookback window in hours (default 48, max 168)" },
  },
  examples: ["volute mind contacts --mind atlas", "volute mind contacts atlas --hours 24"],
  run: async ({ flags }) => {
    assertContactsHours(flags.hours);
    const name = resolveMindName(flags);
    const client = getClient();

    const url = client.api.v1.minds[":name"].history.contacts.$url({ param: { name } });
    if (flags.hours !== undefined) url.searchParams.set("hours", String(flags.hours));

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
