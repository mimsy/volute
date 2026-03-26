import { command } from "../../lib/command.js";
import { daemonFetch } from "../../lib/daemon-client.js";
import { compactTime, isCompact } from "../../lib/format-cli.js";
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
  const res = await daemonFetch(`/api/minds/${encodeURIComponent(mindName)}/conversations`);
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
    limit: { type: "number", description: "Number of messages to show (default 50)" },
  },
  async run({ args, flags }) {
    const mindName = resolveMindName(flags);
    const conversationId = await resolveConversationId(mindName, args.conversation!);
    const limit = String(flags.limit ?? 50);

    const res = await daemonFetch(
      `/api/minds/${encodeURIComponent(mindName)}/conversations/${encodeURIComponent(conversationId)}/messages?limit=${limit}`,
    );
    if (!res.ok) {
      console.error(`Failed to read conversation: ${res.status}`);
      process.exit(1);
    }

    const data = (await res.json()) as {
      items: {
        role: string;
        sender_name: string | null;
        content: string | { type: string; text?: string }[];
        created_at: string;
      }[];
    };

    if (!Array.isArray(data.items)) {
      console.error("Unexpected response format from server");
      process.exit(1);
    }

    const compact = isCompact();
    for (const msg of data.items) {
      const sender = msg.sender_name ?? msg.role;
      const text = Array.isArray(msg.content)
        ? msg.content
            .filter((b): b is { type: "text"; text: string } => b.type === "text")
            .map((b) => b.text)
            .join("")
        : msg.content;
      if (compact) {
        const time = compactTime(msg.created_at);
        console.log(`[${time}] ${sender}: ${text}`);
      } else {
        const time = new Date(
          msg.created_at.endsWith("Z") ? msg.created_at : `${msg.created_at}Z`,
        ).toLocaleString();
        console.log(`[${time}] ${sender}: ${text}`);
      }
    }
  },
});

export const run = cmd.execute;
