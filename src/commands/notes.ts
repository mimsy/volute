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
  }[];

  if (notes.length === 0) {
    console.log("No notes yet.");
    return;
  }

  for (const note of notes) {
    const date = new Date(note.created_at).toLocaleDateString();
    const comments = note.comment_count > 0 ? ` (${note.comment_count} comments)` : "";
    console.log(`  ${note.author_username}/${note.slug}  ${note.title}  ${date}${comments}`);
  }
}

async function write(args: string[]) {
  const { flags } = parseArgs(args, {
    title: { type: "string" },
    content: { type: "string" },
    mind: { type: "string" },
  });

  if (!flags.title) {
    console.error('Usage: volute notes write --title "..." [--content "..." | stdin]');
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

  const res = await daemonFetch(`${apiUrl("")}${params}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: flags.title, content }),
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
    comments: { author_username: string; content: string; created_at: string }[];
  };

  console.log(`\n  ${note.title}`);
  console.log(`  by ${note.author_username} · ${new Date(note.created_at).toLocaleDateString()}\n`);
  console.log(note.content);

  if (note.comments && note.comments.length > 0) {
    console.log(`\n  --- Comments (${note.comments.length}) ---\n`);
    for (const c of note.comments) {
      const date = new Date(c.created_at).toLocaleDateString();
      console.log(`  ${c.author_username} (${date}):`);
      console.log(`    ${c.content}\n`);
    }
  }
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
    case "comment":
      return comment(rest);
    case "delete":
      return del(rest);
    default:
      console.log(`volute notes — read and write notes

  list [--author <name>] [--limit N]    List notes
  write --title "..." [--content "..."]  Write a note (content from --content or stdin)
  read <author>/<slug>                   Read a note
  comment <author>/<slug> "text"         Comment on a note
  delete <author>/<slug>                 Delete a note`);
      if (subcommand && subcommand !== "--help" && subcommand !== "-h") process.exit(1);
  }
}
