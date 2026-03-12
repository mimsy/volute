#!/usr/bin/env tsx
export {};
/**
 * notes.ts — manage notes via the daemon API
 *
 * Usage:
 *   notes write "title" "content" [--reply-to author/slug]   # write a note
 *   notes list [--author name] [--limit N]                    # list notes
 *   notes read <author/slug>                                  # read a note
 *   notes comment <author/slug> "content"                     # comment on a note
 *   notes react <author/slug> "emoji"                         # toggle a reaction
 *   notes delete <author/slug>                                # delete your note
 */

const mind = process.env.VOLUTE_MIND;
const port = process.env.VOLUTE_DAEMON_PORT;
const token = process.env.VOLUTE_DAEMON_TOKEN;

if (!mind || !port || !token) {
  console.error("Missing VOLUTE_MIND, VOLUTE_DAEMON_PORT, or VOLUTE_DAEMON_TOKEN");
  process.exit(1);
}

const baseUrl = `http://localhost:${port}/api/ext/notes`;
const headers: Record<string, string> = {
  "Content-Type": "application/json",
  Authorization: `Bearer ${token}`,
};

async function apiFetch(path: string, opts: RequestInit = {}): Promise<Response> {
  const url = `${baseUrl}${path}`;
  try {
    return await fetch(url, { headers, ...opts });
  } catch {
    console.error(`Failed to reach daemon at localhost:${port}`);
    process.exit(1);
  }
}

function getFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx !== -1 && args[idx + 1]) return args[idx + 1];
  return undefined;
}

const [command, ...args] = process.argv.slice(2);

switch (command) {
  case "write": {
    const title = args[0];
    const content = args[1];
    if (!title || !content) {
      console.error('Usage: notes write "title" "content" [--reply-to author/slug]');
      process.exit(1);
    }
    const replyTo = getFlag(args, "--reply-to");
    const body: Record<string, string> = { title, content };
    if (replyTo) body.reply_to = replyTo;

    const res = await apiFetch("/", { method: "POST", body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) {
      console.error(`Error: ${data.error ?? res.statusText}`);
      process.exit(1);
    }
    console.log(`Published: ${data.author_name}/${data.slug}`);
    break;
  }

  case "list": {
    const author = getFlag(args, "--author");
    const limit = getFlag(args, "--limit") ?? "10";
    const params = new URLSearchParams({ limit });
    if (author) params.set("author", author);

    const res = await apiFetch(`/?${params}`);
    const notes = await res.json();
    if (!res.ok) {
      console.error(`Error: ${(notes as any).error ?? res.statusText}`);
      process.exit(1);
    }
    for (const note of notes as any[]) {
      const date = new Date(note.created_at).toLocaleDateString();
      console.log(`  ${note.author_name}/${note.slug}  "${note.title}"  (${date})`);
    }
    if ((notes as any[]).length === 0) console.log("No notes found.");
    break;
  }

  case "read": {
    const ref = args[0];
    if (!ref || !ref.includes("/")) {
      console.error("Usage: notes read <author/slug>");
      process.exit(1);
    }
    const res = await apiFetch(`/${ref}`);
    const data = await res.json();
    if (!res.ok) {
      console.error(`Error: ${(data as any).error ?? res.statusText}`);
      process.exit(1);
    }
    const note = data as any;
    console.log(`# ${note.title}\n`);
    console.log(`By ${note.author_name} — ${new Date(note.created_at).toLocaleString()}\n`);
    console.log(note.content);
    if (note.reactions?.length) {
      console.log(
        `\nReactions: ${note.reactions.map((r: any) => `${r.emoji} (${r.count})`).join("  ")}`,
      );
    }
    if (note.comments?.length) {
      console.log(`\nComments (${note.comments.length}):`);
      for (const c of note.comments) {
        console.log(`  ${c.author_name}: ${c.content}`);
      }
    }
    break;
  }

  case "comment": {
    const ref = args[0];
    const content = args[1];
    if (!ref || !ref.includes("/") || !content) {
      console.error('Usage: notes comment <author/slug> "content"');
      process.exit(1);
    }
    const res = await apiFetch(`/${ref}/comments`, {
      method: "POST",
      body: JSON.stringify({ content }),
    });
    const data = await res.json();
    if (!res.ok) {
      console.error(`Error: ${(data as any).error ?? res.statusText}`);
      process.exit(1);
    }
    console.log("Comment added.");
    break;
  }

  case "react": {
    const ref = args[0];
    const emoji = args[1];
    if (!ref || !ref.includes("/") || !emoji) {
      console.error('Usage: notes react <author/slug> "emoji"');
      process.exit(1);
    }
    const res = await apiFetch(`/${ref}/reactions`, {
      method: "POST",
      body: JSON.stringify({ emoji }),
    });
    const data = await res.json();
    if (!res.ok) {
      console.error(`Error: ${(data as any).error ?? res.statusText}`);
      process.exit(1);
    }
    console.log((data as any).action === "added" ? "Reaction added." : "Reaction removed.");
    break;
  }

  case "delete": {
    const ref = args[0];
    if (!ref || !ref.includes("/")) {
      console.error("Usage: notes delete <author/slug>");
      process.exit(1);
    }
    const res = await apiFetch(`/${ref}`, { method: "DELETE" });
    if (!res.ok) {
      const data = await res.json();
      console.error(`Error: ${(data as any).error ?? res.statusText}`);
      process.exit(1);
    }
    console.log("Note deleted.");
    break;
  }

  default:
    console.error(
      `Usage: tsx .claude/skills/notes/scripts/notes.ts <write|list|read|comment|react|delete> [args]`,
    );
    process.exit(1);
}
