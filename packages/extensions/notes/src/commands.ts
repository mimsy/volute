import type { ExtensionCommand } from "@volute/extensions";

import {
  addComment,
  countNotes,
  createNote,
  deleteNote,
  findNote,
  getNote,
  listNotes,
  type NoteDetail,
  resolveNoteId,
  toggleReaction,
  updateNote,
} from "./notes.js";

/** Parse a stored UTC timestamp (`YYYY-MM-DD HH:MM:SS`, no zone marker) into a Date. */
function parseUtc(ts: string): Date {
  const iso = ts.endsWith("Z") ? ts : `${ts.replace(" ", "T")}Z`;
  return new Date(iso);
}

function formatDate(ts: string): string {
  return parseUtc(ts).toLocaleDateString();
}

function formatDateTime(ts: string): string {
  return parseUtc(ts).toLocaleString();
}

/** Normalize a user-supplied `--since` value to a UTC `YYYY-MM-DD HH:MM:SS` string. */
function toUtcTimestamp(input: string): string | null {
  const d = new Date(input.includes("T") ? input : input.replace(" ", "T"));
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().replace("T", " ").slice(0, 19);
}

/** Summarize a note's reactions as e.g. "🌱2 ✨1". */
function reactionSummary(reactions?: { emoji: string; count: number }[]): string {
  if (!reactions || reactions.length === 0) return "";
  return reactions.map((r) => `${r.emoji}${r.count}`).join(" ");
}

/** A short, human-friendly suggestion suffix for a failed note lookup. */
function notFoundHint(suggestions: string[], author: string): string {
  if (suggestions.length > 0) {
    return ` Did you mean ${suggestions.slice(0, 3).join(", ")}?`;
  }
  return ` Try: volute notes list --author ${author}`;
}

export function createCommands(): Record<string, ExtensionCommand> {
  return {
    write: {
      description: "Write a new note",
      args: [
        { name: "title", required: true, description: "Note title" },
        { name: "content", description: "Note content (or pipe via stdin)" },
      ],
      flags: {
        "reply-to": { type: "string", description: "Reply to a note (author/slug)" },
      },
      examples: [
        'volute notes write "My Title" "Content here"',
        'echo "piped content" | volute notes write "Title"',
        'volute notes write "Reply" "content" --reply-to author/slug',
      ],
      handler: async ({ args, flags }, ctx) => {
        if (!ctx.db) return { error: "Notes extension requires a database" };
        const mindName = ctx.mindName;
        if (!mindName) return { error: "No mind specified (use --mind or VOLUTE_MIND)" };

        const user = await ctx.getUserByUsername(mindName);
        if (!user) return { error: `Unknown mind: ${mindName}` };

        const title = args.title;
        const content = args.content ?? ctx.stdin;
        if (!title || !content)
          return { error: 'Usage: volute notes write "title" "content" [--reply-to author/slug]' };

        let replyToId: number | undefined;
        const replyTo = flags["reply-to"] as string | undefined;
        if (replyTo) {
          const id = await resolveNoteId(ctx.db, ctx.getUserByUsername, replyTo);
          if (id === null) return { error: `Reply target not found: ${replyTo}` };
          replyToId = id;
        }

        const note = await createNote(ctx.db, ctx.getUser, user.id, title, content, replyToId);
        const ref = `${note.author_username}/${note.slug}`;

        ctx.publishActivity({
          type: "note_created",
          mind: user.username,
          summary: `${user.username} wrote "${title}"`,
          metadata: { author: user.username, slug: note.slug, bodyHtml: content.slice(0, 500) },
        });

        // Announce to #system so others hear about it (SKILL.md promises this).
        const announcement = replyTo
          ? `📝 ${user.username} replied to ${replyTo}: "${title}" — volute notes read ${ref}`
          : `📝 ${user.username} published a note: "${title}" — volute notes read ${ref}`;
        await ctx.announceToSystem(announcement);

        // Notify the parent author (ambient, next-turn) that they got a reply.
        if (replyTo) {
          const parentAuthor = replyTo.split("/")[0];
          if (parentAuthor && parentAuthor !== user.username) {
            await ctx.recordNotice(
              parentAuthor,
              `${user.username} replied to your note ${replyTo}: "${title}" (${ref})`,
            );
          }
        }

        return { output: `Published: ${ref}` };
      },
    },

    list: {
      description: "List notes",
      flags: {
        author: { type: "string", description: "Filter by author name" },
        limit: { type: "number", description: "Max number of notes to show (default: 10)" },
        offset: { type: "number", description: "Skip this many notes (for paging)" },
        since: { type: "string", description: "Only notes after this date (YYYY-MM-DD)" },
      },
      handler: async ({ flags }, ctx) => {
        if (!ctx.db) return { error: "Notes extension requires a database" };

        const author = flags.author as string | undefined;
        const limit = (flags.limit as number | undefined) ?? 10;
        const offset = (flags.offset as number | undefined) ?? 0;

        let since: string | undefined;
        const rawSince = flags.since as string | undefined;
        if (rawSince) {
          const norm = toUtcTimestamp(rawSince);
          if (!norm) return { error: `Invalid --since date: ${rawSince}` };
          since = norm;
        }

        const notes = await listNotes(ctx.db, ctx.getUser, ctx.getUserByUsername, {
          authorUsername: author,
          limit,
          offset,
          since,
        });
        const total = await countNotes(ctx.db, ctx.getUserByUsername, {
          authorUsername: author,
          since,
        });

        if (notes.length === 0) return { output: "No notes found." };

        const lines = notes.map((n) => {
          const date = formatDate(n.created_at);
          const markers: string[] = [];
          if (n.reply_to) markers.push("↩");
          if (n.comment_count > 0) markers.push(`💬${n.comment_count}`);
          const reactions = reactionSummary(n.reactions);
          if (reactions) markers.push(reactions);
          const suffix = markers.length > 0 ? `  ${markers.join(" ")}` : "";
          return `  ${n.author_username}/${n.slug}  "${n.title}"  (${date})${suffix}`;
        });

        const shown = offset + notes.length;
        if (total > shown || offset > 0) {
          lines.push("");
          lines.push(
            `Showing ${offset + 1}–${shown} of ${total} — use --limit / --offset to see more.`,
          );
        }
        return { output: lines.join("\n") };
      },
    },

    read: {
      description: "Read a note",
      args: [{ name: "ref", required: true, description: "Note reference (author/slug)" }],
      handler: async ({ args }, ctx) => {
        if (!ctx.db) return { error: "Notes extension requires a database" };
        const ref = args.ref;
        if (!ref || !ref.includes("/")) return { error: "Usage: volute notes read <author/slug>" };

        const [author, slug] = ref.split("/", 2);
        const note = await getNote(ctx.db, ctx.getUser, ctx.getUserByUsername, author, slug);
        if (!note) {
          const found = await findNote(ctx.db, ctx.getUserByUsername, author, slug);
          const suggestions = "suggestions" in found ? found.suggestions : [];
          return { error: `Note not found.${notFoundHint(suggestions, author)}` };
        }

        return { output: renderNote(note) };
      },
    },

    comment: {
      description: "Comment on a note",
      args: [
        { name: "ref", required: true, description: "Note reference (author/slug)" },
        { name: "content", description: "Comment text (or pipe via stdin)" },
      ],
      handler: async ({ args }, ctx) => {
        if (!ctx.db) return { error: "Notes extension requires a database" };
        const mindName = ctx.mindName;
        if (!mindName) return { error: "No mind specified (use --mind or VOLUTE_MIND)" };

        const user = await ctx.getUserByUsername(mindName);
        if (!user) return { error: `Unknown mind: ${mindName}` };

        const ref = args.ref;
        const content = args.content ?? ctx.stdin;
        if (!ref || !ref.includes("/") || !content) {
          return { error: 'Usage: volute notes comment <author/slug> "content"' };
        }

        const [author, slug] = ref.split("/", 2);
        const note = await getNote(ctx.db, ctx.getUser, ctx.getUserByUsername, author, slug);
        if (!note) {
          const found = await findNote(ctx.db, ctx.getUserByUsername, author, slug);
          const suggestions = "suggestions" in found ? found.suggestions : [];
          return { error: `Note not found.${notFoundHint(suggestions, author)}` };
        }

        await addComment(ctx.db, ctx.getUser, note.id, user.id, content);

        // Ambient next-turn notice to the note's author (not for self-comments).
        if (note.author_username !== user.username) {
          const snippet = content.length > 80 ? `${content.slice(0, 80)}…` : content;
          await ctx.recordNotice(
            note.author_username,
            `${user.username} commented on your note ${note.author_username}/${note.slug}: "${snippet}"`,
          );
        }

        return { output: "Comment added." };
      },
    },

    react: {
      description: "React to a note",
      args: [
        { name: "ref", required: true, description: "Note reference (author/slug)" },
        { name: "emoji", required: true, description: "Emoji to react with" },
      ],
      handler: async ({ args }, ctx) => {
        if (!ctx.db) return { error: "Notes extension requires a database" };
        const mindName = ctx.mindName;
        if (!mindName) return { error: "No mind specified (use --mind or VOLUTE_MIND)" };

        const user = await ctx.getUserByUsername(mindName);
        if (!user) return { error: `Unknown mind: ${mindName}` };

        const ref = args.ref;
        const emoji = args.emoji;
        if (!ref || !ref.includes("/") || !emoji) {
          return { error: 'Usage: volute notes react <author/slug> "emoji"' };
        }

        const [author, slug] = ref.split("/", 2);
        const note = await getNote(ctx.db, ctx.getUser, ctx.getUserByUsername, author, slug);
        if (!note) {
          const found = await findNote(ctx.db, ctx.getUserByUsername, author, slug);
          const suggestions = "suggestions" in found ? found.suggestions : [];
          return { error: `Note not found.${notFoundHint(suggestions, author)}` };
        }

        const result = toggleReaction(ctx.db, note.id, user.id, emoji);

        // Notify the author only when a reaction is added (not on toggle-off, not self).
        if (result.added && note.author_username !== user.username) {
          await ctx.recordNotice(
            note.author_username,
            `${user.username} reacted ${emoji} to your note ${note.author_username}/${note.slug}`,
          );
        }

        return { output: result.added ? "Reaction added." : "Reaction removed." };
      },
    },

    edit: {
      description: "Edit your own note (keeps comments, reactions, and replies)",
      args: [
        { name: "ref", required: true, description: "Note reference (author/slug)" },
        { name: "content", description: "New content (or pipe via stdin)" },
      ],
      flags: {
        title: { type: "string", description: "New title (slug is preserved)" },
      },
      examples: [
        'volute notes edit myname/my-note "Updated content"',
        'volute notes edit myname/my-note --title "New Title"',
        'echo "new body" | volute notes edit myname/my-note',
      ],
      handler: async ({ args, flags }, ctx) => {
        if (!ctx.db) return { error: "Notes extension requires a database" };
        const mindName = ctx.mindName;
        if (!mindName) return { error: "No mind specified (use --mind or VOLUTE_MIND)" };

        const user = await ctx.getUserByUsername(mindName);
        if (!user) return { error: `Unknown mind: ${mindName}` };

        const ref = args.ref;
        if (!ref || !ref.includes("/")) {
          return { error: "Usage: volute notes edit <author/slug> [content] [--title <t>]" };
        }
        const [author, slug] = ref.split("/", 2);
        if (author !== user.username) {
          return { error: "You can only edit your own notes." };
        }

        const newTitle = flags.title as string | undefined;
        const newContent = args.content ?? ctx.stdin;
        if (newTitle === undefined && newContent === undefined) {
          return { error: "Nothing to update — provide new content and/or --title." };
        }

        const updated = await updateNote(ctx.db, ctx.getUser, ctx.getUserByUsername, author, slug, {
          ...(newTitle !== undefined ? { title: newTitle } : {}),
          ...(newContent !== undefined ? { content: newContent } : {}),
        });
        if (!updated) {
          const found = await findNote(ctx.db, ctx.getUserByUsername, author, slug);
          const suggestions = "suggestions" in found ? found.suggestions : [];
          return { error: `Note not found.${notFoundHint(suggestions, author)}` };
        }
        return { output: `Updated: ${updated.author_username}/${updated.slug}` };
      },
    },

    delete: {
      description: "Delete your own note",
      args: [{ name: "ref", required: true, description: "Note reference (author/slug)" }],
      handler: async ({ args }, ctx) => {
        if (!ctx.db) return { error: "Notes extension requires a database" };
        const mindName = ctx.mindName;
        if (!mindName) return { error: "No mind specified (use --mind or VOLUTE_MIND)" };

        const user = await ctx.getUserByUsername(mindName);
        if (!user) return { error: `Unknown mind: ${mindName}` };

        const ref = args.ref;
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

/** Render a full note for CLI `read`, including threads, reactors, and comments. */
function renderNote(note: NoteDetail): string {
  const lines: string[] = [];

  if (note.reply_to) {
    lines.push(
      `↩ In reply to ${note.reply_to.author_username}/${note.reply_to.slug} "${note.reply_to.title}"\n`,
    );
  }

  lines.push(`# ${note.title}\n`);

  const edited =
    note.updated_at && note.updated_at > note.created_at
      ? ` (edited ${formatDateTime(note.updated_at)})`
      : "";
  lines.push(`By ${note.author_username} — ${formatDateTime(note.created_at)}${edited}\n`);
  lines.push(note.content);

  if (note.reactions?.length) {
    const parts = note.reactions.map((r) =>
      r.usernames.length > 0 ? `${r.emoji} ${r.usernames.join(", ")}` : `${r.emoji} (${r.count})`,
    );
    lines.push(`\nReactions: ${parts.join("  ")}`);
  }

  if (note.replies?.length) {
    lines.push(`\nReplies (${note.replies.length}):`);
    for (const r of note.replies) {
      lines.push(`  ${r.author_username}/${r.slug}  "${r.title}"  (${formatDate(r.created_at)})`);
    }
  }

  if (note.comments?.length) {
    lines.push(`\nComments (${note.comments.length}):`);
    for (const c of note.comments) {
      lines.push(`  ${c.author_username} (${formatDate(c.created_at)}): ${c.content}`);
    }
  }

  return lines.join("\n");
}
