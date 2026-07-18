import { getClient, urlOf } from "../lib/api-client.js";
import { command } from "../lib/command.js";
import { daemonFetch } from "../lib/daemon-client.js";
import { readStdin } from "../lib/read-stdin.js";
import { resolveMindName } from "../lib/resolve-mind-name.js";

const cmd = command({
  name: "volute mind summarize",
  description: "Replace a turn's provisional summary with your own account",
  flags: {
    mind: { type: "string", description: "Mind name" },
    turn: { type: "string", description: "Turn id to summarize (from 'volute mind summaries')" },
    text: { type: "string", description: "Summary text (or pipe it via stdin)" },
  },
  examples: [
    'volute mind summarize --turn <id> --text "I traced the routing bug and shipped a fix."',
    'echo "my account of the turn" | volute mind summarize --turn <id>',
  ],
  run: async ({ flags }) => {
    const name = resolveMindName(flags);

    const turnId = flags.turn;
    if (!turnId) {
      console.error("--turn <id> is required (see 'volute mind summaries')");
      process.exit(1);
    }

    const text = flags.text ?? (await readStdin());
    if (!text) {
      console.error("Provide --text or pipe the summary via stdin");
      process.exit(1);
    }

    const client = getClient();
    const url = client.api.minds[":name"]["turn-summaries"].$url({ param: { name } });

    const res = await daemonFetch(urlOf(url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ summaries: [{ turnId, content: text }] }),
    });

    if (!res.ok) {
      let msg = `Failed to save summary: ${res.status}`;
      try {
        const data = (await res.json()) as { error?: string };
        if (data.error) msg = data.error;
      } catch {}
      console.error(msg);
      process.exit(1);
    }

    console.log(`Saved your summary for turn ${turnId.slice(0, 8)}.`);
  },
});

export const run = cmd.execute;
