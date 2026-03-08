import { and, count, desc, eq, sql } from "drizzle-orm";
import { getDb } from "./db.js";
import { noteComments, notes, users } from "./schema.js";
import { slugify } from "./slugify.js";

export type Note = {
  id: number;
  author_id: number;
  title: string;
  slug: string;
  content: string;
  created_at: string;
  updated_at: string;
  author_username: string;
  author_display_name: string | null;
  comment_count: number;
};

export type NoteComment = {
  id: number;
  note_id: number;
  author_id: number;
  content: string;
  created_at: string;
  author_username: string;
  author_display_name: string | null;
};

export async function createNote(authorId: number, title: string, content: string): Promise<Note> {
  const db = await getDb();
  let slug = slugify(title) || "untitled";

  // Handle slug collisions by appending -2, -3, etc.
  const existing = await db
    .select({ slug: notes.slug })
    .from(notes)
    .where(eq(notes.author_id, authorId))
    .all();
  const existingSlugs = new Set(existing.map((r) => r.slug));
  if (existingSlugs.has(slug)) {
    let i = 2;
    while (existingSlugs.has(`${slug}-${i}`)) i++;
    slug = `${slug}-${i}`;
  }

  const [row] = await db
    .insert(notes)
    .values({ author_id: authorId, title, slug, content })
    .returning();

  const author = await db.select().from(users).where(eq(users.id, authorId)).get();

  return {
    ...row,
    author_username: author?.username ?? "unknown",
    author_display_name: author?.display_name ?? null,
    comment_count: 0,
  };
}

export async function getNote(
  authorUsername: string,
  slug: string,
): Promise<(Note & { comments: NoteComment[] }) | null> {
  const db = await getDb();
  const row = await db
    .select({
      id: notes.id,
      author_id: notes.author_id,
      title: notes.title,
      slug: notes.slug,
      content: notes.content,
      created_at: notes.created_at,
      updated_at: notes.updated_at,
      author_username: users.username,
      author_display_name: users.display_name,
    })
    .from(notes)
    .innerJoin(users, eq(notes.author_id, users.id))
    .where(and(eq(users.username, authorUsername), eq(notes.slug, slug)))
    .get();

  if (!row) return null;

  const comments = await getComments(row.id);
  return { ...row, comment_count: comments.length, comments };
}

export async function listNotes(opts?: {
  authorUsername?: string;
  limit?: number;
  offset?: number;
}): Promise<Note[]> {
  const db = await getDb();
  const limit = opts?.limit ?? 50;
  const offset = opts?.offset ?? 0;

  const conditions = [];
  if (opts?.authorUsername) {
    conditions.push(eq(users.username, opts.authorUsername));
  }

  const rows = await db
    .select({
      id: notes.id,
      author_id: notes.author_id,
      title: notes.title,
      slug: notes.slug,
      content: notes.content,
      created_at: notes.created_at,
      updated_at: notes.updated_at,
      author_username: users.username,
      author_display_name: users.display_name,
    })
    .from(notes)
    .innerJoin(users, eq(notes.author_id, users.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(notes.created_at))
    .limit(limit)
    .offset(offset)
    .all();

  // Get comment counts
  const noteIds = rows.map((r) => r.id);
  if (noteIds.length === 0) return [];

  const commentCounts = await db
    .select({
      note_id: noteComments.note_id,
      count: count(),
    })
    .from(noteComments)
    .groupBy(noteComments.note_id)
    .all();

  const countMap = new Map(commentCounts.map((r) => [r.note_id, r.count]));

  return rows.map((r) => ({
    ...r,
    comment_count: countMap.get(r.id) ?? 0,
  }));
}

export async function updateNote(
  authorUsername: string,
  slug: string,
  updates: { title?: string; content?: string },
): Promise<Note | null> {
  const db = await getDb();
  const existing = await db
    .select({ id: notes.id, author_id: notes.author_id })
    .from(notes)
    .innerJoin(users, eq(notes.author_id, users.id))
    .where(and(eq(users.username, authorUsername), eq(notes.slug, slug)))
    .get();

  if (!existing) return null;

  const set: Record<string, unknown> = { updated_at: sql`(datetime('now'))` };
  if (updates.title !== undefined) set.title = updates.title;
  if (updates.content !== undefined) set.content = updates.content;

  await db.update(notes).set(set).where(eq(notes.id, existing.id));

  return getNote(authorUsername, slug).then((n) =>
    n ? { ...n, comments: undefined as any } : null,
  );
}

export async function deleteNote(
  authorUsername: string,
  slug: string,
  authorId: number,
): Promise<boolean> {
  const db = await getDb();
  const existing = await db
    .select({ id: notes.id, author_id: notes.author_id })
    .from(notes)
    .innerJoin(users, eq(notes.author_id, users.id))
    .where(and(eq(users.username, authorUsername), eq(notes.slug, slug)))
    .get();

  if (!existing || existing.author_id !== authorId) return false;

  await db.delete(notes).where(eq(notes.id, existing.id));
  return true;
}

export async function addComment(
  noteId: number,
  authorId: number,
  content: string,
): Promise<NoteComment> {
  const db = await getDb();
  const [row] = await db
    .insert(noteComments)
    .values({ note_id: noteId, author_id: authorId, content })
    .returning();

  const author = await db.select().from(users).where(eq(users.id, authorId)).get();

  return {
    ...row,
    author_username: author?.username ?? "unknown",
    author_display_name: author?.display_name ?? null,
  };
}

export async function getComments(noteId: number): Promise<NoteComment[]> {
  const db = await getDb();
  return db
    .select({
      id: noteComments.id,
      note_id: noteComments.note_id,
      author_id: noteComments.author_id,
      content: noteComments.content,
      created_at: noteComments.created_at,
      author_username: users.username,
      author_display_name: users.display_name,
    })
    .from(noteComments)
    .innerJoin(users, eq(noteComments.author_id, users.id))
    .where(eq(noteComments.note_id, noteId))
    .orderBy(noteComments.created_at)
    .all();
}

export async function deleteComment(commentId: number, authorId: number): Promise<boolean> {
  const db = await getDb();
  const existing = await db
    .select({ id: noteComments.id, author_id: noteComments.author_id })
    .from(noteComments)
    .where(eq(noteComments.id, commentId))
    .get();

  if (!existing || existing.author_id !== authorId) return false;

  await db.delete(noteComments).where(eq(noteComments.id, commentId));
  return true;
}
