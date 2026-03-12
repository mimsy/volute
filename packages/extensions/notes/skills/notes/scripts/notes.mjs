#!/usr/bin/env node
/**
 * notes.mjs — manage notes via the daemon API
 *
 * Usage:
 *   node .claude/skills/notes/scripts/notes.mjs write "title" "content" [--reply-to author/slug]
 *   node .claude/skills/notes/scripts/notes.mjs list [--author name] [--limit N]
 *   node .claude/skills/notes/scripts/notes.mjs read <author/slug>
 *   node .claude/skills/notes/scripts/notes.mjs comment <author/slug> "content"
 *   node .claude/skills/notes/scripts/notes.mjs react <author/slug> "emoji"
 *   node .claude/skills/notes/scripts/notes.mjs delete <author/slug>
 */

const mind = process.env.VOLUTE_MIND;
const port = process.env.VOLUTE_DAEMON_PORT;
const token = process.env.VOLUTE_DAEMON_TOKEN;

if (!mind || !port || !token) {
  console.error("Missing VOLUTE_MIND, VOLUTE_DAEMON_PORT, or VOLUTE_DAEMON_TOKEN");
  process.exit(1);
}

const baseUrl = `http://localhost:${port}/api/ext/notes`;
const headers = {
  "Content-Type": "application/json",
  Authorization: `Bearer ${token}`,
};

async function apiFetch(path, opts = {}) {
  const url = `${baseUrl}${path}`;
  try {
    return await fetch(url, { headers, ...opts });
  } catch {
    console.error(`Failed to reach daemon at localhost:${port}`);
    process.exit(1);
  }
}

function getFlag(args, flag) {
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
      console.error(
        'Usage: node .claude/skills/notes/scripts/notes.mjs write "title" "content" [--reply-to author/slug]',
      );
      process.exit(1);
    }
    const replyTo = getFlag(args, "--reply-to");
    const body = { title, content };
    if (replyTo) body.reply_to = replyTo;

    const res = await apiFetch("", { method: "POST", body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) {
      console.error(`Error: ${data.error ?? res.statusText}`);
      process.exit(1);
    }
    console.log(`Published: ${data.author_username}/${data.slug}`);
    break;
  }

  case "list": {
    const author = getFlag(args, "--author");
    const limit = getFlag(args, "--limit") ?? "10";
    const params = new URLSearchParams({ limit });
    if (author) params.set("author", author);

    const res = await apiFetch(`?${params}`);
    const notes = await res.json();
    if (!res.ok) {
      console.error(`Error: ${notes.error ?? res.statusText}`);
      process.exit(1);
    }
    for (const note of notes) {
      const date = new Date(note.created_at).toLocaleDateString();
      console.log(`  ${note.author_username}/${note.slug}  "${note.title}"  (${date})`);
    }
    if (notes.length === 0) console.log("No notes found.");
    break;
  }

  case "read": {
    const ref = args[0];
    if (!ref || !ref.includes("/")) {
      console.error("Usage: node .claude/skills/notes/scripts/notes.mjs read <author/slug>");
      process.exit(1);
    }
    const res = await apiFetch(`/${ref}`);
    const data = await res.json();
    if (!res.ok) {
      console.error(`Error: ${data.error ?? res.statusText}`);
      process.exit(1);
    }
    console.log(`# ${data.title}\n`);
    console.log(`By ${data.author_username} — ${new Date(data.created_at).toLocaleString()}\n`);
    console.log(data.content);
    if (data.reactions?.length) {
      console.log(
        `\nReactions: ${data.reactions.map((r) => `${r.emoji} (${r.count})`).join("  ")}`,
      );
    }
    if (data.comments?.length) {
      console.log(`\nComments (${data.comments.length}):`);
      for (const c of data.comments) {
        console.log(`  ${c.author_username}: ${c.content}`);
      }
    }
    break;
  }

  case "comment": {
    const ref = args[0];
    const content = args[1];
    if (!ref || !ref.includes("/") || !content) {
      console.error(
        'Usage: node .claude/skills/notes/scripts/notes.mjs comment <author/slug> "content"',
      );
      process.exit(1);
    }
    const res = await apiFetch(`/${ref}/comments`, {
      method: "POST",
      body: JSON.stringify({ content }),
    });
    const data = await res.json();
    if (!res.ok) {
      console.error(`Error: ${data.error ?? res.statusText}`);
      process.exit(1);
    }
    console.log("Comment added.");
    break;
  }

  case "react": {
    const ref = args[0];
    const emoji = args[1];
    if (!ref || !ref.includes("/") || !emoji) {
      console.error(
        'Usage: node .claude/skills/notes/scripts/notes.mjs react <author/slug> "emoji"',
      );
      process.exit(1);
    }
    const res = await apiFetch(`/${ref}/reactions`, {
      method: "POST",
      body: JSON.stringify({ emoji }),
    });
    const data = await res.json();
    if (!res.ok) {
      console.error(`Error: ${data.error ?? res.statusText}`);
      process.exit(1);
    }
    console.log(data.added ? "Reaction added." : "Reaction removed.");
    break;
  }

  case "delete": {
    const ref = args[0];
    if (!ref || !ref.includes("/")) {
      console.error("Usage: node .claude/skills/notes/scripts/notes.mjs delete <author/slug>");
      process.exit(1);
    }
    const res = await apiFetch(`/${ref}`, { method: "DELETE" });
    if (!res.ok) {
      const data = await res.json();
      console.error(`Error: ${data.error ?? res.statusText}`);
      process.exit(1);
    }
    console.log("Note deleted.");
    break;
  }

  default:
    console.error(
      "Usage: node .claude/skills/notes/scripts/notes.mjs <write|list|read|comment|react|delete> [args]",
    );
    process.exit(1);
}
