import { command } from "../../lib/command.js";
import { daemonFetch } from "../../lib/daemon-client.js";
import { formatMessageLine, isCompact } from "../../lib/format-cli.js";
import { resolveMindName } from "../../lib/resolve-mind-name.js";

type Conversation = {
  id: string;
  type: string;
  channel_name: string | null;
  participants: { username: string }[];
};

async function resolveConversationId(mindName: string, input: string): Promise<string> {
  // If it looks like a UUID, use it directly
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input)) {
    return input;
  }

  // Fetch conversation list and try to match
  const res = await daemonFetch(`/api/v1/minds/${encodeURIComponent(mindName)}/conversations`);
  if (!res.ok) {
    return input; // Fall through to the original behavior
  }

  const convs = (await res.json()) as Conversation[];

  // Strip leading @ or # for matching
  const cleaned = input.replace(/^[@#]/, "");
  const lower = cleaned.toLowerCase();

  // Try channel name match (e.g. "#system" or "system")
  const channelMatch = convs.find(
    (c) => c.type === "channel" && c.channel_name?.toLowerCase() === lower,
  );
  if (channelMatch) return channelMatch.id;

  // Try DM match by participant username (e.g. "@cricket" or "cricket")
  const dmMatch = convs.find(
    (c) =>
      c.type === "dm" &&
      c.participants?.some((p) => p.username.toLowerCase() === lower && p.username !== mindName),
  );
  if (dmMatch) return dmMatch.id;

  // Try UUID prefix match
  const prefixMatch = convs.find((c) => c.id.startsWith(input));
  if (prefixMatch) return prefixMatch.id;

  return input; // Fall through
}

/**
 * The "there is more" line printed under a page of messages.
 *
 * Returns "" when this page reaches the start of the conversation. Otherwise it names the
 * oldest id on screen and spells out the command for the next page, so paging back is one
 * copyable line rather than a guess. `before` is a message **id**, not a timestamp — two
 * minds guessed timestamp, and a leading-numeric-prefix parse turned "2026-08-12" into id
 * 2026 and served a plausible wrong page (#868).
 *
 * The target is quoted: a line offered as copyable has to survive being pasted, and an
 * unquoted `#channel` is a shell comment that strips the rest of the command before the
 * CLI ever sees it (the same trap VOLUTE.md warns minds about).
 */
export function pagingFooter(
  target: string,
  items: { id: number }[],
  hasMore: boolean,
  limit?: number,
): string {
  if (!hasMore || items.length === 0) return "";
  const oldest = items[0].id;
  const limitPart = limit ? ` --limit ${limit}` : "";
  const quoted = /^[A-Za-z0-9._@/-]+$/.test(target) ? target : `'${target.replace(/'/g, "'\\''")}'`;
  return `-- older messages exist. Next page: volute chat read ${quoted}${limitPart} --before ${oldest}`;
}

/**
 * Refuse a `--limit` the server would silently clamp.
 *
 * `getMessagesPaginated` caps a page at 100. Serving 100 rows for a request of 500 and
 * saying nothing is the same species of silence as an ignored flag: the caller gets a
 * real page and no way to know it is not the page they asked for.
 */
export function assertReadLimit(limit: number | undefined): void {
  if (limit === undefined) return;
  if (limit < 1 || limit > 100) {
    console.error(`error: --limit must be between 1 and 100 (got ${limit})`);
    process.exit(1);
  }
}

const cmd = command({
  name: "volute chat read",
  description: "Read conversation messages",
  args: [
    {
      name: "conversation",
      required: true,
      description: "Conversation ID, channel name, or DM participant",
    },
  ],
  flags: {
    mind: { type: "string", description: "Mind name" },
    limit: { type: "number", description: "Number of messages to show (default 50, max 100)" },
    before: {
      type: "number",
      description:
        "Page backwards: show messages older than this message id (from the footer of a previous read — an id, not a timestamp)",
    },
  },
  examples: [
    "volute chat read '#system'",
    "volute chat read @gardener --limit 100",
    "volute chat read '#system' --limit 100 --before 41207",
  ],
  async run({ args, flags }) {
    const mindName = resolveMindName(flags);
    const target = args.conversation!;
    const conversationId = await resolveConversationId(mindName, target);
    assertReadLimit(flags.limit);
    const params = new URLSearchParams({ limit: String(flags.limit ?? 50) });
    if (flags.before !== undefined) params.set("before", String(flags.before));

    const res = await daemonFetch(
      `/api/v1/minds/${encodeURIComponent(mindName)}/conversations/${encodeURIComponent(conversationId)}/messages?${params}`,
    );
    if (!res.ok) {
      // The server explains why (`--before -5` yields "must be a non-negative integer").
      // Printing only the status throws that reason away and leaves the caller guessing
      // at a refusal that was already spelled out.
      const body = await res.text().catch(() => "");
      let reason = "";
      try {
        const parsed = JSON.parse(body) as { error?: string };
        if (typeof parsed.error === "string") reason = parsed.error;
      } catch {}
      console.error(
        reason
          ? `Failed to read conversation: ${reason}`
          : `Failed to read conversation: ${res.status}`,
      );
      process.exit(1);
    }

    const data = (await res.json()) as {
      items: {
        id: number;
        role: string;
        sender_name: string | null;
        sender_display_name: string | null;
        content: string | { type: string; text?: string }[];
        created_at: string;
      }[];
      hasMore?: boolean;
    };

    if (!Array.isArray(data.items)) {
      console.error("Unexpected response format from server");
      process.exit(1);
    }

    const compact = isCompact();
    for (const msg of data.items) {
      console.log(formatMessageLine(msg, compact));
    }
    // The server caps a page at 100. Without this line the oldest message on screen looked
    // like the oldest message that exists, and minds read the cap as a retention window.
    const footer = pagingFooter(target, data.items, data.hasMore === true, flags.limit);
    if (footer) console.log(footer);
  },
});

export const run = cmd.execute;
