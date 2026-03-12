import type { ExtensionContext } from "@volute/extension-sdk";
import { Hono } from "hono";

import {
  addComment,
  createNote,
  deleteComment,
  deleteNote,
  getNote,
  getReactions,
  listNotes,
  resolveNoteId,
  toggleReaction,
  updateNote,
} from "./notes.js";

function resolveUserId(c: {
  get: (key: string) => unknown;
}): { id: number; username: string } | null {
  const user = c.get("user") as { id: number; username: string } | undefined;
  if (!user || user.id === 0) return null;
  return { id: user.id, username: user.username };
}

export function createRoutes(ctx: ExtensionContext): Hono {
  const { db, getUser, getUserByUsername } = ctx;

  const app = new Hono()
    // List notes
    .get("/", async (c) => {
      const author = c.req.query("author");
      const rawLimit = c.req.query("limit");
      const rawOffset = c.req.query("offset");
      const limit = rawLimit ? parseInt(rawLimit, 10) : undefined;
      const offset = rawOffset ? parseInt(rawOffset, 10) : undefined;
      if (
        (limit !== undefined && Number.isNaN(limit)) ||
        (offset !== undefined && Number.isNaN(offset))
      ) {
        return c.json({ error: "Invalid limit or offset parameter" }, 400);
      }
      const result = await listNotes(db, getUser, getUserByUsername, {
        authorUsername: author,
        limit,
        offset,
      });
      return c.json(result);
    })

    // Create note
    .post("/", async (c) => {
      const actor = resolveUserId(c);
      if (!actor) return c.json({ error: "Unauthorized" }, 401);

      const body = await c.req.json<{ title?: string; content?: string; reply_to?: string }>();
      if (!body.title || !body.content) {
        return c.json({ error: "title and content are required" }, 400);
      }

      let replyToId: number | undefined;
      if (body.reply_to) {
        const id = await resolveNoteId(db, getUserByUsername, body.reply_to);
        if (id === null) return c.json({ error: `Reply target not found: ${body.reply_to}` }, 404);
        replyToId = id;
      }

      const note = await createNote(db, getUser, actor.id, body.title, body.content, replyToId);

      ctx.publishActivity({
        type: "note_created",
        mindName: actor.username,
        title: body.title,
        data: { author: actor.username, slug: note.slug },
      });

      return c.json(note, 201);
    })

    // Get note by author/slug
    .get("/:author/:slug", async (c) => {
      const { author, slug } = c.req.param();
      const note = await getNote(db, getUser, getUserByUsername, author, slug);
      if (!note) return c.json({ error: "Note not found" }, 404);
      return c.json(note);
    })

    // Update note
    .put("/:author/:slug", async (c) => {
      const actor = resolveUserId(c);
      if (!actor) return c.json({ error: "Unauthorized" }, 401);

      const { author, slug } = c.req.param();
      if (actor.username !== author) return c.json({ error: "Forbidden" }, 403);

      const body = await c.req.json<{ title?: string; content?: string }>();
      const note = await updateNote(db, getUser, getUserByUsername, author, slug, body);
      if (!note) return c.json({ error: "Note not found" }, 404);
      return c.json(note);
    })

    // Delete note
    .delete("/:author/:slug", async (c) => {
      const actor = resolveUserId(c);
      if (!actor) return c.json({ error: "Unauthorized" }, 401);

      const { author, slug } = c.req.param();
      const deleted = await deleteNote(db, getUserByUsername, author, slug, actor.id);
      if (!deleted) return c.json({ error: "Note not found or not authorized" }, 404);
      return c.json({ ok: true });
    })

    // Toggle reaction
    .post("/:author/:slug/reactions", async (c) => {
      const actor = resolveUserId(c);
      if (!actor) return c.json({ error: "Unauthorized" }, 401);

      const { author, slug } = c.req.param();
      const note = await getNote(db, getUser, getUserByUsername, author, slug);
      if (!note) return c.json({ error: "Note not found" }, 404);

      const body = await c.req.json<{ emoji?: string }>();
      if (!body.emoji) return c.json({ error: "emoji is required" }, 400);

      const result = toggleReaction(db, note.id, actor.id, body.emoji);
      const reactions = await getReactions(db, getUser, note.id);
      return c.json({ ...result, reactions });
    })

    // Add comment
    .post("/:author/:slug/comments", async (c) => {
      const actor = resolveUserId(c);
      if (!actor) return c.json({ error: "Unauthorized" }, 401);

      const { author, slug } = c.req.param();
      const note = await getNote(db, getUser, getUserByUsername, author, slug);
      if (!note) return c.json({ error: "Note not found" }, 404);

      const body = await c.req.json<{ content?: string }>();
      if (!body.content) return c.json({ error: "content is required" }, 400);

      const comment = await addComment(db, getUser, note.id, actor.id, body.content);
      return c.json(comment, 201);
    })

    // Delete comment
    .delete("/:author/:slug/comments/:id", async (c) => {
      const actor = resolveUserId(c);
      if (!actor) return c.json({ error: "Unauthorized" }, 401);

      const commentId = parseInt(c.req.param("id"), 10);
      if (Number.isNaN(commentId)) return c.json({ error: "Invalid comment ID" }, 400);

      const deleted = await deleteComment(db, commentId, actor.id);
      if (!deleted) return c.json({ error: "Comment not found or not authorized" }, 404);
      return c.json({ ok: true });
    })

    // Feed endpoint — returns recent notes as ExtensionFeedItems
    .get("/feed", async (c) => {
      const rawFeedLimit = c.req.query("limit");
      const limit = rawFeedLimit ? parseInt(rawFeedLimit, 10) : 8;
      if (Number.isNaN(limit)) return c.json({ error: "Invalid limit parameter" }, 400);
      const notes = await listNotes(db, getUser, getUserByUsername, { limit });
      return c.json(
        notes.map((n) => ({
          id: `note-${n.author_username}-${n.slug}`,
          title: n.title,
          url: `/notes/${n.author_username}/${n.slug}`,
          date: n.created_at,
          author: n.author_username,
          bodyHtml: `<p>${escapeHtml(n.content.length > 150 ? `${n.content.slice(0, 150)}...` : n.content)}</p>`,
        })),
      );
    });

  return app;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
