import type { Database, ExtensionContext } from "@volute/extensions";

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

export type NoteDetail = Note & {
  comments: NoteComment[];
  replies: NoteReply[];
};

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/['’]/g, "") // drop apostrophes so "Skeleton's" → "skeletons", not "skeleton-s"
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Normalize a slug for fuzzy comparison: strip every non-alphanumeric so
 *  "the-skeleton-s-calendar" and "the-skeletons-calendar" compare equal. */
function normalizeSlug(slug: string): string {
  return slug.toLowerCase().replace(/[^a-z0-9]/g, "");
}

type UserLookup = ExtensionContext["getUser"];
type UserByUsernameLookup = ExtensionContext["getUserByUsername"];

export async function createNote(
  db: Database,
  getUser: UserLookup,
  authorId: number,
  title: string,
  content: string,
  replyToId?: number,
): Promise<Note> {
  const baseSlug = slugify(title) || "untitled";

  const existing = db.prepare("SELECT slug FROM notes WHERE author_id = ?").all(authorId) as {
    slug: string;
  }[];
  const existingSlugs = new Set(existing.map((r) => r.slug));

  function nextSlug(taken: Set<string>): string {
    if (!taken.has(baseSlug)) return baseSlug;
    let i = 2;
    while (taken.has(`${baseSlug}-${i}`)) i++;
    return `${baseSlug}-${i}`;
  }

  type NoteRow = {
    id: number;
    author_id: number;
    title: string;
    slug: string;
    content: string;
    reply_to_id: number | null;
    created_at: string;
    updated_at: string;
  };

  // Retry on UNIQUE(author_id, slug) violations so a concurrent same-title write
  // (read-then-insert race) resolves to the next free suffix instead of a 500.
  let row: NoteRow | undefined;
  for (let attempt = 0; attempt < 5 && !row; attempt++) {
    const slug = nextSlug(existingSlugs);
    try {
      row = db
        .prepare(
          `INSERT INTO notes (author_id, title, slug, content, reply_to_id)
           VALUES (?, ?, ?, ?, ?)
           RETURNING *`,
        )
        .get(authorId, title, slug, content, replyToId ?? null) as NoteRow;
    } catch (err) {
      if (!/UNIQUE/i.test((err as Error).message)) throw err;
      existingSlugs.add(slug); // a racer took it; try the next suffix
    }
  }
  if (!row) throw new Error("Failed to allocate a unique slug for note");

  const author = await getUser(authorId);

  return {
    ...row,
    author_username: author?.username ?? "unknown",
    author_display_name: author?.display_name ?? null,
    comment_count: 0,
  };
}

export type FindNoteResult = { authorId: number; slug: string } | { suggestions: string[] };

/**
 * Resolve an author/slug reference, tolerating small slug mismatches (e.g. a hand-typed
 * "the-skeletons-calendar" for the stored "the-skeleton-s-calendar"). Exact match wins;
 * otherwise a *unique* match on the apostrophe/punctuation-insensitive normalized slug
 * resolves transparently. On no/ambiguous match, returns `author/slug` suggestions.
 */
export async function findNote(
  db: Database,
  getUserByUsername: UserByUsernameLookup,
  authorUsername: string,
  slug: string,
): Promise<FindNoteResult> {
  const author = await getUserByUsername(authorUsername);
  if (!author) return { suggestions: [] };

  const exact = db
    .prepare("SELECT slug FROM notes WHERE author_id = ? AND slug = ?")
    .get(author.id, slug) as { slug: string } | undefined;
  if (exact) return { authorId: author.id, slug };

  const all = db.prepare("SELECT slug FROM notes WHERE author_id = ?").all(author.id) as {
    slug: string;
  }[];
  const target = normalizeSlug(slug);
  const fuzzy = all.filter((r) => normalizeSlug(r.slug) === target);
  if (fuzzy.length === 1) return { authorId: author.id, slug: fuzzy[0].slug };

  // Ambiguous normalized match → offer those; otherwise offer the author's slugs.
  const pool = fuzzy.length > 1 ? fuzzy : all;
  return { suggestions: pool.slice(0, 10).map((r) => `${authorUsername}/${r.slug}`) };
}

export async function getNote(
  db: Database,
  getUser: UserLookup,
  getUserByUsername: UserByUsernameLookup,
  authorUsername: string,
  slug: string,
): Promise<NoteDetail | null> {
  const author = await getUserByUsername(authorUsername);
  if (!author) return null;

  const found = await findNote(db, getUserByUsername, authorUsername, slug);
  if (!("authorId" in found)) return null;

  const row = db
    .prepare("SELECT * FROM notes WHERE author_id = ? AND slug = ?")
    .get(author.id, found.slug) as
    | {
        id: number;
        author_id: number;
        title: string;
        slug: string;
        content: string;
        reply_to_id: number | null;
        created_at: string;
        updated_at: string;
      }
    | undefined;

  if (!row) return null;

  const comments = await getComments(db, getUser, row.id);
  const reactions = await getReactions(db, getUser, row.id);

  let reply_to: Note["reply_to"] = null;
  if (row.reply_to_id) {
    const parent = db.prepare("SELECT * FROM notes WHERE id = ?").get(row.reply_to_id) as
      | {
          id: number;
          author_id: number;
          title: string;
          slug: string;
        }
      | undefined;
    if (parent) {
      const parentAuthor = await getUser(parent.author_id);
      reply_to = {
        author_username: parentAuthor?.username ?? "unknown",
        slug: parent.slug,
        title: parent.title,
      };
    }
  }

  const replyRows = db
    .prepare("SELECT * FROM notes WHERE reply_to_id = ? ORDER BY created_at")
    .all(row.id) as { author_id: number; slug: string; title: string; created_at: string }[];

  const replies: NoteReply[] = [];
  for (const r of replyRows) {
    const replyAuthor = await getUser(r.author_id);
    replies.push({
      author_username: replyAuthor?.username ?? "unknown",
      slug: r.slug,
      title: r.title,
      created_at: r.created_at,
    });
  }

  return {
    ...row,
    author_username: authorUsername,
    author_display_name: author.display_name ?? null,
    comment_count: comments.length,
    comments,
    reactions,
    reply_to,
    replies,
  };
}

/** Build a `WHERE` clause + params from optional author/since filters. */
function noteFilter(
  authorId: number | undefined,
  since: string | undefined,
): {
  clause: string;
  params: unknown[];
} {
  const conds: string[] = [];
  const params: unknown[] = [];
  if (authorId !== undefined) {
    conds.push("author_id = ?");
    params.push(authorId);
  }
  if (since) {
    conds.push("created_at > ?");
    params.push(since);
  }
  return { clause: conds.length ? `WHERE ${conds.join(" AND ")}` : "", params };
}

export async function listNotes(
  db: Database,
  getUser: UserLookup,
  getUserByUsername: UserByUsernameLookup,
  opts?: { authorUsername?: string; limit?: number; offset?: number; since?: string },
): Promise<Note[]> {
  const limit = opts?.limit ?? 50;
  const offset = opts?.offset ?? 0;

  let authorId: number | undefined;
  if (opts?.authorUsername) {
    const author = await getUserByUsername(opts.authorUsername);
    if (!author) return [];
    authorId = author.id;
  }

  const { clause, params } = noteFilter(authorId, opts?.since);
  const rows = db
    .prepare(`SELECT * FROM notes ${clause} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as any[];

  if (rows.length === 0) return [];

  const noteIds = rows.map((r: any) => r.id);

  // Comment counts
  const commentCounts = db
    .prepare(
      `SELECT note_id, COUNT(*) as count FROM note_comments
       WHERE note_id IN (${noteIds.map(() => "?").join(",")})
       GROUP BY note_id`,
    )
    .all(...noteIds) as { note_id: number; count: number }[];
  const countMap = new Map(commentCounts.map((r) => [r.note_id, r.count]));

  // Reaction summaries
  const allReactions = db
    .prepare(
      `SELECT note_id, emoji, COUNT(*) as count FROM note_reactions
       WHERE note_id IN (${noteIds.map(() => "?").join(",")})
       GROUP BY note_id, emoji`,
    )
    .all(...noteIds) as { note_id: number; emoji: string; count: number }[];

  const reactionMap = new Map<number, { emoji: string; count: number }[]>();
  for (const r of allReactions) {
    if (!reactionMap.has(r.note_id)) reactionMap.set(r.note_id, []);
    reactionMap.get(r.note_id)!.push({ emoji: r.emoji, count: r.count });
  }

  // Reply-to info
  const replyToIds = [
    ...new Set(rows.filter((r: any) => r.reply_to_id).map((r: any) => r.reply_to_id as number)),
  ];
  const replyToMap = new Map<number, { author_username: string; slug: string; title: string }>();
  if (replyToIds.length > 0) {
    const parents = db
      .prepare(`SELECT * FROM notes WHERE id IN (${replyToIds.map(() => "?").join(",")})`)
      .all(...replyToIds) as { id: number; author_id: number; title: string; slug: string }[];
    for (const parent of parents) {
      const parentAuthor = await getUser(parent.author_id);
      replyToMap.set(parent.id, {
        author_username: parentAuthor?.username ?? "unknown",
        slug: parent.slug,
        title: parent.title,
      });
    }
  }

  // Author info cache
  const authorCache = new Map<number, { username: string; display_name: string | null }>();

  const result: Note[] = [];
  for (const r of rows) {
    if (!authorCache.has(r.author_id)) {
      const u = await getUser(r.author_id);
      authorCache.set(r.author_id, {
        username: u?.username ?? "unknown",
        display_name: u?.display_name ?? null,
      });
    }
    const authorInfo = authorCache.get(r.author_id)!;

    const reactions = reactionMap.get(r.id);
    const topReactions = reactions
      ? reactions
          .sort((a, b) => b.count - a.count)
          .slice(0, 3)
          .map((rx) => ({ ...rx, usernames: [] }))
      : undefined;

    result.push({
      ...r,
      author_username: authorInfo.username,
      author_display_name: authorInfo.display_name,
      comment_count: countMap.get(r.id) ?? 0,
      reactions: topReactions,
      reply_to: r.reply_to_id ? (replyToMap.get(r.reply_to_id) ?? null) : null,
    });
  }

  return result;
}

/** Total notes matching the same author/since filters as listNotes (ignoring limit/offset). */
export async function countNotes(
  db: Database,
  getUserByUsername: UserByUsernameLookup,
  opts?: { authorUsername?: string; since?: string },
): Promise<number> {
  let authorId: number | undefined;
  if (opts?.authorUsername) {
    const author = await getUserByUsername(opts.authorUsername);
    if (!author) return 0;
    authorId = author.id;
  }
  const { clause, params } = noteFilter(authorId, opts?.since);
  const row = db.prepare(`SELECT COUNT(*) as count FROM notes ${clause}`).get(...params) as {
    count: number;
  };
  return row.count;
}

export async function updateNote(
  db: Database,
  getUser: UserLookup,
  getUserByUsername: UserByUsernameLookup,
  authorUsername: string,
  slug: string,
  updates: { title?: string; content?: string },
): Promise<Note | null> {
  const author = await getUserByUsername(authorUsername);
  if (!author) return null;

  const existing = db
    .prepare("SELECT id FROM notes WHERE author_id = ? AND slug = ?")
    .get(author.id, slug) as { id: number } | undefined;
  if (!existing) return null;

  const sets: string[] = ["updated_at = datetime('now')"];
  const params: unknown[] = [];
  if (updates.title !== undefined) {
    sets.push("title = ?");
    params.push(updates.title);
  }
  if (updates.content !== undefined) {
    sets.push("content = ?");
    params.push(updates.content);
  }
  params.push(existing.id);
  db.prepare(`UPDATE notes SET ${sets.join(", ")} WHERE id = ?`).run(...params);

  const full = await getNote(db, getUser, getUserByUsername, authorUsername, slug);
  if (!full) return null;
  const { comments, replies, ...note } = full;
  return note;
}

export async function deleteNote(
  db: Database,
  getUserByUsername: UserByUsernameLookup,
  authorUsername: string,
  slug: string,
  authorId: number,
): Promise<boolean> {
  const author = await getUserByUsername(authorUsername);
  if (!author) return false;

  const existing = db
    .prepare("SELECT id, author_id FROM notes WHERE author_id = ? AND slug = ?")
    .get(author.id, slug) as { id: number; author_id: number } | undefined;
  if (!existing || existing.author_id !== authorId) return false;

  db.prepare("DELETE FROM notes WHERE id = ?").run(existing.id);
  return true;
}

export async function addComment(
  db: Database,
  getUser: UserLookup,
  noteId: number,
  authorId: number,
  content: string,
): Promise<NoteComment> {
  const row = db
    .prepare(`INSERT INTO note_comments (note_id, author_id, content) VALUES (?, ?, ?) RETURNING *`)
    .get(noteId, authorId, content) as {
    id: number;
    note_id: number;
    author_id: number;
    content: string;
    created_at: string;
  };

  const author = await getUser(authorId);
  return {
    ...row,
    author_username: author?.username ?? "unknown",
    author_display_name: author?.display_name ?? null,
  };
}

export async function getComments(
  db: Database,
  getUser: UserLookup,
  noteId: number,
): Promise<NoteComment[]> {
  const rows = db
    .prepare("SELECT * FROM note_comments WHERE note_id = ? ORDER BY created_at")
    .all(noteId) as {
    id: number;
    note_id: number;
    author_id: number;
    content: string;
    created_at: string;
  }[];

  const result: NoteComment[] = [];
  for (const row of rows) {
    const author = await getUser(row.author_id);
    result.push({
      ...row,
      author_username: author?.username ?? "unknown",
      author_display_name: author?.display_name ?? null,
    });
  }
  return result;
}

/**
 * Delete a comment. Authorized when the actor is the comment's author, the author of the
 * note it's on (so note owners can moderate their shelf), or an admin.
 */
export async function deleteComment(
  db: Database,
  commentId: number,
  actor: { id: number; role?: string },
): Promise<boolean> {
  const existing = db
    .prepare(
      `SELECT c.id AS id, c.author_id AS comment_author, n.author_id AS note_author
       FROM note_comments c JOIN notes n ON n.id = c.note_id
       WHERE c.id = ?`,
    )
    .get(commentId) as { id: number; comment_author: number; note_author: number } | undefined;
  if (!existing) return false;

  const authorized =
    actor.role === "admin" ||
    actor.id === existing.comment_author ||
    actor.id === existing.note_author;
  if (!authorized) return false;

  db.prepare("DELETE FROM note_comments WHERE id = ?").run(existing.id);
  return true;
}

export function toggleReaction(
  db: Database,
  noteId: number,
  userId: number,
  emoji: string,
): { added: boolean } {
  const existing = db
    .prepare("SELECT id FROM note_reactions WHERE note_id = ? AND user_id = ? AND emoji = ?")
    .get(noteId, userId, emoji) as { id: number } | undefined;

  if (existing) {
    db.prepare("DELETE FROM note_reactions WHERE id = ?").run(existing.id);
    return { added: false };
  }

  db.prepare("INSERT INTO note_reactions (note_id, user_id, emoji) VALUES (?, ?, ?)").run(
    noteId,
    userId,
    emoji,
  );
  return { added: true };
}

export async function getReactions(
  db: Database,
  getUser: UserLookup,
  noteId: number,
): Promise<{ emoji: string; count: number; usernames: string[] }[]> {
  const rows = db
    .prepare("SELECT * FROM note_reactions WHERE note_id = ? ORDER BY emoji")
    .all(noteId) as { emoji: string; user_id: number }[];

  const userCache = new Map<number, string>();
  const grouped = new Map<string, number[]>();

  for (const r of rows) {
    if (!grouped.has(r.emoji)) grouped.set(r.emoji, []);
    grouped.get(r.emoji)!.push(r.user_id);
  }

  const result: { emoji: string; count: number; usernames: string[] }[] = [];
  for (const [emoji, userIds] of grouped) {
    const usernames: string[] = [];
    for (const uid of userIds) {
      if (!userCache.has(uid)) {
        const u = await getUser(uid);
        userCache.set(uid, u?.username ?? "unknown");
      }
      usernames.push(userCache.get(uid)!);
    }
    result.push({ emoji, count: userIds.length, usernames });
  }

  return result;
}

export async function resolveNoteId(
  db: Database,
  getUserByUsername: UserByUsernameLookup,
  authorSlug: string,
): Promise<number | null> {
  const parts = authorSlug.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const [authorName, slug] = parts;
  const found = await findNote(db, getUserByUsername, authorName, slug);
  if (!("authorId" in found)) return null;
  const row = db
    .prepare("SELECT id FROM notes WHERE author_id = ? AND slug = ?")
    .get(found.authorId, found.slug) as { id: number } | undefined;
  return row?.id ?? null;
}
