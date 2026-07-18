import { getClient, urlOf } from "../lib/api-client.js";
import { command } from "../lib/command.js";
import { daemonFetch } from "../lib/daemon-client.js";
import { compactTime } from "../lib/format-cli.js";
import { resolveMindName } from "../lib/resolve-mind-name.js";

type TurnSummaryRow = {
  turnId: string;
  created_at: string;
  thread: string | null;
  status: string;
  content: string | null;
  author: "mind" | "summarizer" | null;
};

const cmd = command({
  name: "volute mind summaries",
  description: "List your recent turns and their summaries (provisional, or your own)",
  flags: {
    mind: { type: "string", description: "Mind name" },
    session: { type: "string", description: "Filter by session/thread" },
    limit: { type: "string", description: "Number of turns to show (default 20, max 100)" },
  },
  examples: [
    "volute mind summaries",
    "volute mind summaries --limit 40",
    "volute mind summaries --session <thread>",
  ],
  run: async ({ flags }) => {
    const name = resolveMindName(flags);
    const client = getClient();

    const url = client.api.minds[":name"]["turn-summaries"].$url({ param: { name } });
    if (flags.session) url.searchParams.set("session", flags.session);
    if (flags.limit) url.searchParams.set("limit", flags.limit);

    const res = await daemonFetch(urlOf(url));
    if (!res.ok) {
      let msg = `Failed to get turn summaries: ${res.status}`;
      try {
        const data = (await res.json()) as { error?: string };
        if (data.error) msg = data.error;
      } catch {}
      console.error(msg);
      process.exit(1);
    }

    const rows = (await res.json()) as TurnSummaryRow[];
    if (rows.length === 0) {
      console.log("No turns found.");
      return;
    }

    // API returns newest first; print oldest→newest so it reads top-to-bottom in time.
    for (const row of rows.reverse()) {
      const time = compactTime(row.created_at);
      const shortId = row.turnId.slice(0, 8);
      const source = row.author === "mind" ? "you " : row.author === "summarizer" ? "auto" : "----";
      const thread = row.thread ? ` [${row.thread}]` : "";
      const content = row.content ?? "(no summary yet)";
      console.log(`[${time}] (${source}) ${shortId}${thread}: ${content}`);
    }
    console.log(
      '\nReplace any with your own words: volute mind summarize --turn <id> --text "..."',
    );
  },
});

export const run = cmd.execute;
