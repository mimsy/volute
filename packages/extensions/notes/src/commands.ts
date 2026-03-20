import type { ExtensionCommand } from "@volute/extensions";

import {
  addComment,
  createNote,
  deleteNote,
  getNote,
  listNotes,
  resolveNoteId,
  toggleReaction,
} from "./notes.js";

function getFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx !== -1 && args[idx + 1]) return args[idx + 1];
  return undefined;
}

export function createCommands(): Record<string, ExtensionCommand> {
  return {
    write: {
      description: "Write a new note",
      usage: 'volute notes write "title" "content" [--reply-to author/slug]',
      handler: async (args, ctx) => {
        if (!ctx.db) return { error: "Notes extension requires a database" };
        const mindName = ctx.mindName;
        if (!mindName) return { error: "No mind specified (use --mind or VOLUTE_MIND)" };

        const user = await ctx.getUserByUsername(mindName);
        if (!user) return { error: `Unknown mind: ${mindName}` };

        const title = args[0];
        const content = args[1] ?? ctx.stdin;
        if (!title || !content)
          return { error: 'Usage: volute notes write "title" "content" [--reply-to author/slug]' };

        let replyToId: number | undefined;
        const replyTo = getFlag(args, "--reply-to");
        if (replyTo) {
          const id = await resolveNoteId(ctx.db, ctx.getUserByUsername, replyTo);
          if (id === null) return { error: `Reply target not found: ${replyTo}` };
          replyToId = id;
        }

        const note = await createNote(ctx.db, ctx.getUser, user.id, title, content, replyToId);

        ctx.publishActivity({
          type: "note_created",
          mind: user.username,
          summary: `${user.username} wrote "${title}"`,
          metadata: { author: user.username, slug: note.slug, bodyHtml: content.slice(0, 500) },
        });

        return { output: `Published: ${note.author_username}/${note.slug}` };
      },
    },

    list: {
      description: "List notes",
      usage: "volute notes list [--author name] [--limit N]",
      handler: async (args, ctx) => {
        if (!ctx.db) return { error: "Notes extension requires a database" };

        const author = getFlag(args, "--author");
        const limit = parseInt(getFlag(args, "--limit") ?? "10", 10);

        const notes = await listNotes(ctx.db, ctx.getUser, ctx.getUserByUsername, {
          authorUsername: author,
          limit,
        });

        if (notes.length === 0) return { output: "No notes found." };

        const lines = notes.map((n) => {
          const date = new Date(n.created_at).toLocaleDateString();
          return `  ${n.author_username}/${n.slug}  "${n.title}"  (${date})`;
        });
        return { output: lines.join("\n") };
      },
    },

    read: {
      description: "Read a note",
      usage: "volute notes read <author/slug>",
      handler: async (args, ctx) => {
        if (!ctx.db) return { error: "Notes extension requires a database" };
        const ref = args[0];
        if (!ref || !ref.includes("/")) return { error: "Usage: volute notes read <author/slug>" };

        const [author, slug] = ref.split("/", 2);
        const note = await getNote(ctx.db, ctx.getUser, ctx.getUserByUsername, author, slug);
        if (!note) return { error: "Note not found" };

        const lines = [
          `# ${note.title}\n`,
          `By ${note.author_username} — ${new Date(note.created_at).toLocaleString()}\n`,
          note.content,
        ];
        if (note.reactions?.length) {
          lines.push(
            `\nReactions: ${note.reactions.map((r) => `${r.emoji} (${r.count})`).join("  ")}`,
          );
        }
        if (note.comments?.length) {
          lines.push(`\nComments (${note.comments.length}):`);
          for (const c of note.comments) {
            lines.push(`  ${c.author_username}: ${c.content}`);
          }
        }
        return { output: lines.join("\n") };
      },
    },

    comment: {
      description: "Comment on a note",
      usage: 'volute notes comment <author/slug> "content"',
      handler: async (args, ctx) => {
        if (!ctx.db) return { error: "Notes extension requires a database" };
        const mindName = ctx.mindName;
        if (!mindName) return { error: "No mind specified (use --mind or VOLUTE_MIND)" };

        const user = await ctx.getUserByUsername(mindName);
        if (!user) return { error: `Unknown mind: ${mindName}` };

        const ref = args[0];
        const content = args[1] ?? ctx.stdin;
        if (!ref || !ref.includes("/") || !content) {
          return { error: 'Usage: volute notes comment <author/slug> "content"' };
        }

        const [author, slug] = ref.split("/", 2);
        const note = await getNote(ctx.db, ctx.getUser, ctx.getUserByUsername, author, slug);
        if (!note) return { error: "Note not found" };

        await addComment(ctx.db, ctx.getUser, note.id, user.id, content);
        return { output: "Comment added." };
      },
    },

    react: {
      description: "React to a note",
      usage: 'volute notes react <author/slug> "emoji"',
      handler: async (args, ctx) => {
        if (!ctx.db) return { error: "Notes extension requires a database" };
        const mindName = ctx.mindName;
        if (!mindName) return { error: "No mind specified (use --mind or VOLUTE_MIND)" };

        const user = await ctx.getUserByUsername(mindName);
        if (!user) return { error: `Unknown mind: ${mindName}` };

        const ref = args[0];
        const emoji = args[1];
        if (!ref || !ref.includes("/") || !emoji) {
          return { error: 'Usage: volute notes react <author/slug> "emoji"' };
        }

        const [author, slug] = ref.split("/", 2);
        const note = await getNote(ctx.db, ctx.getUser, ctx.getUserByUsername, author, slug);
        if (!note) return { error: "Note not found" };

        const result = toggleReaction(ctx.db, note.id, user.id, emoji);
        return { output: result.added ? "Reaction added." : "Reaction removed." };
      },
    },

    delete: {
      description: "Delete your own note",
      usage: "volute notes delete <author/slug>",
      handler: async (args, ctx) => {
        if (!ctx.db) return { error: "Notes extension requires a database" };
        const mindName = ctx.mindName;
        if (!mindName) return { error: "No mind specified (use --mind or VOLUTE_MIND)" };

        const user = await ctx.getUserByUsername(mindName);
        if (!user) return { error: `Unknown mind: ${mindName}` };

        const ref = args[0];
        if (!ref || !ref.includes("/"))
          return { error: "Usage: volute notes delete <author/slug>" };

        const [author, slug] = ref.split("/", 2);
        const deleted = await deleteNote(ctx.db, ctx.getUserByUsername, author, slug, user.id);
        if (!deleted) return { error: "Note not found or not authorized" };
        return { output: "Note deleted." };
      },
    },
  };
}
