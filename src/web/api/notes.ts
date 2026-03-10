import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
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
} from "../../lib/notes.js";
import { announceToSystem } from "../../lib/system-channel.js";
import type { AuthEnv } from "../middleware/auth.js";

const createSchema = z.object({
  title: z.string().min(1).max(200),
  content: z.string().min(1),
  reply_to: z.string().optional(),
});

const updateSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  content: z.string().min(1).optional(),
});

const commentSchema = z.object({
  content: z.string().min(1),
});

const reactionSchema = z.object({
  emoji: z.string().min(1).max(32),
});

/**
 * Resolve the acting user from the authenticated session.
 * Users can only act as themselves — no impersonation.
 */
function resolveUserId(c: {
  get: (key: "user") => { id: number; username: string };
}): { id: number; username: string } | null {
  const user = c.get("user");
  // Daemon token (id=0) has no real user identity
  if (user.id === 0) return null;
  return { id: user.id, username: user.username };
}

const app = new Hono<AuthEnv>()
  // List notes
  .get("/", async (c) => {
    const author = c.req.query("author");
    const limit = c.req.query("limit") ? parseInt(c.req.query("limit")!, 10) : undefined;
    const offset = c.req.query("offset") ? parseInt(c.req.query("offset")!, 10) : undefined;
    const result = await listNotes({ authorUsername: author, limit, offset });
    return c.json(result);
  })

  // Create note
  .post("/", zValidator("json", createSchema), async (c) => {
    const actor = resolveUserId(c);
    if (!actor) return c.json({ error: "Unauthorized" }, 401);

    const { title, content, reply_to } = c.req.valid("json");

    // Resolve reply_to author/slug to note ID
    let replyToId: number | undefined;
    if (reply_to) {
      const id = await resolveNoteId(reply_to);
      if (id === null) return c.json({ error: `Reply target not found: ${reply_to}` }, 404);
      replyToId = id;
    }

    const note = await createNote(actor.id, title, content, replyToId);

    // Announce to #system
    const replyInfo = reply_to ? ` (in reply to ${reply_to})` : "";
    announceToSystem(`${actor.username} published a note: ${title}${replyInfo}`).catch(() => {});

    return c.json(note, 201);
  })

  // Get note by author/slug
  .get("/:author/:slug", async (c) => {
    const { author, slug } = c.req.param();
    const note = await getNote(author, slug);
    if (!note) return c.json({ error: "Note not found" }, 404);
    return c.json(note);
  })

  // Update note
  .put("/:author/:slug", zValidator("json", updateSchema), async (c) => {
    const actor = resolveUserId(c);
    if (!actor) return c.json({ error: "Unauthorized" }, 401);

    const { author, slug } = c.req.param();

    // Only the author can update
    if (actor.username !== author) return c.json({ error: "Forbidden" }, 403);

    const updates = c.req.valid("json");
    const note = await updateNote(author, slug, updates);
    if (!note) return c.json({ error: "Note not found" }, 404);
    return c.json(note);
  })

  // Delete note
  .delete("/:author/:slug", async (c) => {
    const actor = resolveUserId(c);
    if (!actor) return c.json({ error: "Unauthorized" }, 401);

    const { author, slug } = c.req.param();
    const deleted = await deleteNote(author, slug, actor.id);
    if (!deleted) return c.json({ error: "Note not found or not authorized" }, 404);
    return c.json({ ok: true });
  })

  // Toggle reaction
  .post("/:author/:slug/reactions", zValidator("json", reactionSchema), async (c) => {
    const actor = resolveUserId(c);
    if (!actor) return c.json({ error: "Unauthorized" }, 401);

    const { author, slug } = c.req.param();
    const note = await getNote(author, slug);
    if (!note) return c.json({ error: "Note not found" }, 404);

    const { emoji } = c.req.valid("json");
    const result = await toggleReaction(note.id, actor.id, emoji);
    const reactions = await getReactions(note.id);
    return c.json({ ...result, reactions });
  })

  // Add comment
  .post("/:author/:slug/comments", zValidator("json", commentSchema), async (c) => {
    const actor = resolveUserId(c);
    if (!actor) return c.json({ error: "Unauthorized" }, 401);

    const { author, slug } = c.req.param();
    const note = await getNote(author, slug);
    if (!note) return c.json({ error: "Note not found" }, 404);

    const { content } = c.req.valid("json");
    const comment = await addComment(note.id, actor.id, content);
    return c.json(comment, 201);
  })

  // Delete comment
  .delete("/:author/:slug/comments/:id", async (c) => {
    const actor = resolveUserId(c);
    if (!actor) return c.json({ error: "Unauthorized" }, 401);

    const commentId = parseInt(c.req.param("id"), 10);
    if (Number.isNaN(commentId)) return c.json({ error: "Invalid comment ID" }, 400);

    const deleted = await deleteComment(commentId, actor.id);
    if (!deleted) return c.json({ error: "Comment not found or not authorized" }, 404);
    return c.json({ ok: true });
  });

export default app;
