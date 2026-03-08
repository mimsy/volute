import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { getOrCreateMindUser, getUserByUsername } from "../../lib/auth.js";
import {
  addComment,
  createNote,
  deleteComment,
  deleteNote,
  getNote,
  listNotes,
  updateNote,
} from "../../lib/notes.js";
import { announceToSystem } from "../../lib/system-channel.js";
import type { AuthEnv } from "../middleware/auth.js";

const createSchema = z.object({
  title: z.string().min(1).max(200),
  content: z.string().min(1),
});

const updateSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  content: z.string().min(1).optional(),
});

const commentSchema = z.object({
  content: z.string().min(1),
});

/**
 * Resolve the acting user ID. For daemon-token (CLI/mind) requests,
 * if `?as=<username>` is provided, resolve that user instead.
 */
async function resolveUserId(c: {
  get: (key: "user") => { id: number; username: string };
  req: { query: (key: string) => string | undefined };
}): Promise<{ id: number; username: string } | null> {
  const user = c.get("user");
  // Daemon token auth gives id=0 — resolve real user from `?as=` query param
  if (user.id === 0) {
    const asUser = c.req.query("as");
    if (!asUser) return null;
    // Try mind user first, then brain user
    try {
      const mindUser = await getOrCreateMindUser(asUser);
      return { id: mindUser.id, username: mindUser.username };
    } catch {
      const brainUser = await getUserByUsername(asUser);
      if (brainUser) return { id: brainUser.id, username: brainUser.username };
      return null;
    }
  }
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
    const actor = await resolveUserId(c);
    if (!actor) return c.json({ error: "Missing ?as=<username> for CLI requests" }, 400);

    const { title, content } = c.req.valid("json");
    const note = await createNote(actor.id, title, content);

    // Announce to #system
    announceToSystem(`${actor.username} published a note: ${title}`).catch(() => {});

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
    const actor = await resolveUserId(c);
    if (!actor) return c.json({ error: "Missing ?as=<username> for CLI requests" }, 400);

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
    const actor = await resolveUserId(c);
    if (!actor) return c.json({ error: "Missing ?as=<username> for CLI requests" }, 400);

    const { author, slug } = c.req.param();
    const deleted = await deleteNote(author, slug, actor.id);
    if (!deleted) return c.json({ error: "Note not found or not authorized" }, 404);
    return c.json({ ok: true });
  })

  // Add comment
  .post("/:author/:slug/comments", zValidator("json", commentSchema), async (c) => {
    const actor = await resolveUserId(c);
    if (!actor) return c.json({ error: "Missing ?as=<username> for CLI requests" }, 400);

    const { author, slug } = c.req.param();
    const note = await getNote(author, slug);
    if (!note) return c.json({ error: "Note not found" }, 404);

    const { content } = c.req.valid("json");
    const comment = await addComment(note.id, actor.id, content);
    return c.json(comment, 201);
  })

  // Delete comment
  .delete("/:author/:slug/comments/:id", async (c) => {
    const actor = await resolveUserId(c);
    if (!actor) return c.json({ error: "Missing ?as=<username> for CLI requests" }, 400);

    const commentId = parseInt(c.req.param("id"), 10);
    if (Number.isNaN(commentId)) return c.json({ error: "Invalid comment ID" }, 400);

    const deleted = await deleteComment(commentId, actor.id);
    if (!deleted) return c.json({ error: "Comment not found or not authorized" }, 404);
    return c.json({ ok: true });
  });

export default app;
