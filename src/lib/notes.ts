import { and, count, desc, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "./db.js";
import { noteComments, noteReactions, notes, users } from "./schema.js";
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
  reply_to?: { author_username: string; slug: string; title: string } | null;
  reactions?: { emoji: string; count: number; usernames: string[] }[];
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

export type NoteReply = {
  author_username: string;
  slug: string;
  title: string;
  created_at: string;
};

export async function createNote(
  authorId: number,
  title: string,
  content: string,
  replyToId?: number,
): Promise<Note> {
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
    .values({ author_id: authorId, title, slug, content, reply_to_id: replyToId ?? null })
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
): Promise<(Note & { comments: NoteComment[]; replies: NoteReply[] }) | null> {
  const db = await getDb();
  const row = await db
    .select({
      id: notes.id,
      author_id: notes.author_id,
      title: notes.title,
      slug: notes.slug,
      content: notes.content,
      reply_to_id: notes.reply_to_id,
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
  const reactions = await getReactions(row.id);

  // Resolve reply_to
  let reply_to: Note["reply_to"] = null;
  if (row.reply_to_id) {
    const parent = await db
      .select({
        title: notes.title,
        slug: notes.slug,
        author_username: users.username,
      })
      .from(notes)
      .innerJoin(users, eq(notes.author_id, users.id))
      .where(eq(notes.id, row.reply_to_id))
      .get();
    if (parent) {
      reply_to = parent;
    }
  }

  // Get replies to this note
  const replies = await db
    .select({
      author_username: users.username,
      slug: notes.slug,
      title: notes.title,
      created_at: notes.created_at,
    })
    .from(notes)
    .innerJoin(users, eq(notes.author_id, users.id))
    .where(eq(notes.reply_to_id, row.id))
    .orderBy(notes.created_at)
    .all();

  return { ...row, comment_count: comments.length, comments, reactions, reply_to, replies };
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
      reply_to_id: notes.reply_to_id,
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
    .where(inArray(noteComments.note_id, noteIds))
    .groupBy(noteComments.note_id)
    .all();

  const countMap = new Map(commentCounts.map((r) => [r.note_id, r.count]));

  // Get reaction summaries (top 3 per note)
  const allReactions = await db
    .select({
      note_id: noteReactions.note_id,
      emoji: noteReactions.emoji,
      count: count(),
    })
    .from(noteReactions)
    .where(inArray(noteReactions.note_id, noteIds))
    .groupBy(noteReactions.note_id, noteReactions.emoji)
    .all();

  const reactionMap = new Map<number, { emoji: string; count: number }[]>();
  for (const r of allReactions) {
    if (!reactionMap.has(r.note_id)) reactionMap.set(r.note_id, []);
    reactionMap.get(r.note_id)!.push({ emoji: r.emoji, count: r.count });
  }

  // Resolve reply_to info for notes that are replies
  const replyToIds = [...new Set(rows.filter((r) => r.reply_to_id).map((r) => r.reply_to_id!))];
  const replyToMap = new Map<number, { author_username: string; slug: string; title: string }>();
  if (replyToIds.length > 0) {
    const parents = await db
      .select({
        id: notes.id,
        title: notes.title,
        slug: notes.slug,
        author_username: users.username,
      })
      .from(notes)
      .innerJoin(users, eq(notes.author_id, users.id))
      .where(inArray(notes.id, replyToIds))
      .all();
    for (const parent of parents) {
      replyToMap.set(parent.id, {
        author_username: parent.author_username,
        slug: parent.slug,
        title: parent.title,
      });
    }
  }

  return rows.map((r) => {
    const reactions = reactionMap.get(r.id);
    const topReactions = reactions
      ? reactions
          .sort((a, b) => b.count - a.count)
          .slice(0, 3)
          .map((rx) => ({ ...rx, usernames: [] }))
      : undefined;

    return {
      ...r,
      comment_count: countMap.get(r.id) ?? 0,
      reactions: topReactions,
      reply_to: r.reply_to_id ? (replyToMap.get(r.reply_to_id) ?? null) : null,
    };
  });
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

export async function toggleReaction(
  noteId: number,
  userId: number,
  emoji: string,
): Promise<{ added: boolean }> {
  const db = await getDb();
  const existing = await db
    .select({ id: noteReactions.id })
    .from(noteReactions)
    .where(
      and(
        eq(noteReactions.note_id, noteId),
        eq(noteReactions.user_id, userId),
        eq(noteReactions.emoji, emoji),
      ),
    )
    .get();

  if (existing) {
    await db.delete(noteReactions).where(eq(noteReactions.id, existing.id));
    return { added: false };
  }

  await db.insert(noteReactions).values({ note_id: noteId, user_id: userId, emoji });
  return { added: true };
}

export async function getReactions(
  noteId: number,
): Promise<{ emoji: string; count: number; usernames: string[] }[]> {
  const db = await getDb();
  const rows = await db
    .select({
      emoji: noteReactions.emoji,
      username: users.username,
    })
    .from(noteReactions)
    .innerJoin(users, eq(noteReactions.user_id, users.id))
    .where(eq(noteReactions.note_id, noteId))
    .orderBy(noteReactions.emoji)
    .all();

  const grouped = new Map<string, string[]>();
  for (const r of rows) {
    if (!grouped.has(r.emoji)) grouped.set(r.emoji, []);
    grouped.get(r.emoji)!.push(r.username);
  }

  return [...grouped.entries()].map(([emoji, usernames]) => ({
    emoji,
    count: usernames.length,
    usernames,
  }));
}

export async function resolveNoteId(authorSlug: string): Promise<number | null> {
  const [author, slug] = authorSlug.split("/", 2);
  if (!author || !slug) return null;
  const db = await getDb();
  const row = await db
    .select({ id: notes.id })
    .from(notes)
    .innerJoin(users, eq(notes.author_id, users.id))
    .where(and(eq(users.username, author), eq(notes.slug, slug)))
    .get();
  return row?.id ?? null;
}
