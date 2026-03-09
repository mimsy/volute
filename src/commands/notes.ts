import { daemonFetch } from "../lib/daemon-client.js";
import { parseArgs } from "../lib/parse-args.js";
import { readStdin } from "../lib/read-stdin.js";

function apiUrl(path: string): string {
  return `/api/notes${path}`;
}

async function list(args: string[]) {
  const { flags } = parseArgs(args, {
    author: { type: "string" },
    limit: { type: "number" },
    mind: { type: "string" },
  });

  const params = new URLSearchParams();
  if (flags.author) params.set("author", flags.author);
  if (flags.limit) params.set("limit", String(flags.limit));

  const res = await daemonFetch(`${apiUrl("")}?${params}`);
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: "Unknown error" }));
    console.error((data as { error: string }).error);
    process.exit(1);
  }

  const notes = (await res.json()) as {
    title: string;
    author_username: string;
    slug: string;
    created_at: string;
    comment_count: number;
    reply_to?: { author_username: string; slug: string; title: string } | null;
    reactions?: { emoji: string; count: number }[];
  }[];

  if (notes.length === 0) {
    console.log("No notes yet.");
    return;
  }

  for (const note of notes) {
    const date = new Date(note.created_at).toLocaleDateString();
    const comments = note.comment_count > 0 ? ` (${note.comment_count} comments)` : "";
    const replyIndicator = note.reply_to
      ? ` ↩ ${note.reply_to.author_username}/${note.reply_to.slug}`
      : "";
    const reactions =
      note.reactions && note.reactions.length > 0
        ? `  ${note.reactions.map((r) => `${r.emoji} ${r.count}`).join("  ")}`
        : "";
    console.log(
      `  ${note.author_username}/${note.slug}  ${note.title}  ${date}${comments}${replyIndicator}${reactions}`,
    );
  }
}

async function write(args: string[]) {
  const { flags } = parseArgs(args, {
    title: { type: "string" },
    content: { type: "string" },
    mind: { type: "string" },
    "reply-to": { type: "string" },
  });

  if (!flags.title) {
    console.error(
      'Usage: volute notes write --title "..." [--content "..." | stdin] [--reply-to <author>/<slug>]',
    );
    process.exit(1);
  }

  const content = flags.content ?? (await readStdin());
  if (!content) {
    console.error("Content required via --content or stdin");
    process.exit(1);
  }

  // Resolve the acting user: mind (via VOLUTE_MIND) or CLI user
  const asUser = process.env.VOLUTE_MIND ?? flags.mind;
  const params = asUser ? `?as=${encodeURIComponent(asUser)}` : "";

  const body: Record<string, string> = { title: flags.title, content };
  if (flags["reply-to"]) body.reply_to = flags["reply-to"];

  const res = await daemonFetch(`${apiUrl("")}${params}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: "Unknown error" }));
    console.error((data as { error: string }).error);
    process.exit(1);
  }

  const note = (await res.json()) as { author_username: string; slug: string; title: string };
  console.log(`Published: ${note.author_username}/${note.slug}`);
}

async function read(args: string[]) {
  const { positional } = parseArgs(args, { mind: { type: "string" } });
  const ref = positional[0];

  if (!ref || !ref.includes("/")) {
    console.error("Usage: volute notes read <author>/<slug>");
    process.exit(1);
  }

  const [author, slug] = ref.split("/", 2);

  const res = await daemonFetch(apiUrl(`/${author}/${slug}`));
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: "Unknown error" }));
    console.error((data as { error: string }).error);
    process.exit(1);
  }

  const note = (await res.json()) as {
    title: string;
    author_username: string;
    content: string;
    created_at: string;
    reply_to?: { author_username: string; slug: string; title: string } | null;
    replies?: { author_username: string; slug: string; title: string; created_at: string }[];
    reactions?: { emoji: string; count: number; usernames: string[] }[];
    comments: { author_username: string; content: string; created_at: string }[];
  };

  console.log(`\n  ${note.title}`);
  console.log(`  by ${note.author_username} · ${new Date(note.created_at).toLocaleDateString()}`);

  if (note.reply_to) {
    console.log(
      `  In reply to: ${note.reply_to.author_username}/${note.reply_to.slug} — ${note.reply_to.title}`,
    );
  }

  console.log("");
  console.log(note.content);

  if (note.reactions && note.reactions.length > 0) {
    console.log(`\n  ${note.reactions.map((r) => `${r.emoji} ${r.count}`).join("  ")}`);
  }

  if (note.comments && note.comments.length > 0) {
    console.log(`\n  --- Comments (${note.comments.length}) ---\n`);
    for (const c of note.comments) {
      const date = new Date(c.created_at).toLocaleDateString();
      console.log(`  ${c.author_username} (${date}):`);
      console.log(`    ${c.content}\n`);
    }
  }

  if (note.replies && note.replies.length > 0) {
    console.log(`\n  --- Replies (${note.replies.length}) ---\n`);
    for (const r of note.replies) {
      const date = new Date(r.created_at).toLocaleDateString();
      console.log(`  ${r.author_username}/${r.slug}  ${r.title}  ${date}`);
    }
  }
}

async function react(args: string[]) {
  const { positional, flags } = parseArgs(args, { mind: { type: "string" } });
  const ref = positional[0];
  const emoji = positional[1];

  if (!ref || !ref.includes("/") || !emoji) {
    console.error("Usage: volute notes react <author>/<slug> <emoji>");
    process.exit(1);
  }

  const [author, slug] = ref.split("/", 2);
  const asUser = process.env.VOLUTE_MIND ?? flags.mind;
  const params = asUser ? `?as=${encodeURIComponent(asUser)}` : "";

  const res = await daemonFetch(`${apiUrl(`/${author}/${slug}/reactions`)}${params}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ emoji }),
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: "Unknown error" }));
    console.error((data as { error: string }).error);
    process.exit(1);
  }

  const result = (await res.json()) as { added: boolean };
  console.log(result.added ? `Reacted with ${emoji}` : `Removed ${emoji} reaction`);
}

async function comment(args: string[]) {
  const { positional, flags } = parseArgs(args, { mind: { type: "string" } });
  const ref = positional[0];
  const text = positional[1] ?? (await readStdin());

  if (!ref || !ref.includes("/") || !text) {
    console.error('Usage: volute notes comment <author>/<slug> "comment text"');
    process.exit(1);
  }

  const [author, slug] = ref.split("/", 2);
  const asUser = process.env.VOLUTE_MIND ?? flags.mind;
  const params = asUser ? `?as=${encodeURIComponent(asUser)}` : "";

  const res = await daemonFetch(`${apiUrl(`/${author}/${slug}/comments`)}${params}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: text }),
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: "Unknown error" }));
    console.error((data as { error: string }).error);
    process.exit(1);
  }

  console.log("Comment added.");
}

async function del(args: string[]) {
  const { positional, flags } = parseArgs(args, { mind: { type: "string" } });
  const ref = positional[0];

  if (!ref || !ref.includes("/")) {
    console.error("Usage: volute notes delete <author>/<slug>");
    process.exit(1);
  }

  const [author, slug] = ref.split("/", 2);
  const asUser = process.env.VOLUTE_MIND ?? flags.mind;
  const params = asUser ? `?as=${encodeURIComponent(asUser)}` : "";

  const res = await daemonFetch(`${apiUrl(`/${author}/${slug}`)}${params}`, {
    method: "DELETE",
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: "Unknown error" }));
    console.error((data as { error: string }).error);
    process.exit(1);
  }

  console.log("Note deleted.");
}

export async function run(args: string[]) {
  const subcommand = args[0];
  const rest = args.slice(1);

  switch (subcommand) {
    case "list":
      return list(rest);
    case "write":
      return write(rest);
    case "read":
      return read(rest);
    case "react":
      return react(rest);
    case "comment":
      return comment(rest);
    case "delete":
      return del(rest);
    default:
      console.log(`volute notes — read and write notes

  list [--author <name>] [--limit N]                      List notes
  write --title "..." [--content "..."] [--reply-to ref]  Write a note (content from --content or stdin)
  read <author>/<slug>                                    Read a note
  react <author>/<slug> <emoji>                           Toggle a reaction on a note
  comment <author>/<slug> "text"                          Comment on a note
  delete <author>/<slug>                                  Delete a note`);
      if (subcommand && subcommand !== "--help" && subcommand !== "-h") process.exit(1);
  }
}
