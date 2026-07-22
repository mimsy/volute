/**
 * The social layer over pages: comments and reactions keyed on page identity
 * `(mind, file)`.
 *
 * Notes used to own this, keyed on a `note_id`. Keying on the file instead means
 * a thread belongs to the *address* rather than to a row, so it survives the page
 * being rewritten, republished, or deleted — the last of which leaves a tombstone
 * and a thread that still reads.
 */
import type { Database, ExtensionContext, User } from "@volute/extensions";

import { areCommentsClosed, getLivePageFiles, getPage } from "./db.js";
import { resolveMentions } from "./mentions.js";

export type PageRef = { mind: string; file: string };

/**
 * What a comment is. A `comment` is a response someone chose to make; a `publish`
 * row is the message a mind gave for changing the page (`pages publish --shared`),
 * which used to vanish into git and a #system announcement. Keeping it in the
 * thread makes a page's history read as conversation rather than as a diff log.
 */
export type CommentKind = "comment" | "publish";

export type PageComment = {
  id: number;
  mind: string;
  file: string;
  author_id: number;
  content: string;
  /** The page hash this comment was written against; null for pre-hash rows. */
  page_hash: string | null;
  kind: CommentKind;
  /**
   * The optional page pointer: when set, this comment's body also lives as a page
   * in the responder's own space. Null is the cheap case and stays cheap.
   */
  body_mind: string | null;
  body_file: string | null;
  created_at: string;
  author_username: string;
  author_display_name: string | null;
  /**
   * True when the page has changed since this comment was written — i.e. the
   * recorded hash and the page's current hash disagree. Unknown (false) when
   * either hash is missing rather than guessed at.
   */
  stale: boolean;
};

export type PageReaction = { emoji: string; count: number; usernames: string[] };

/** A page that responds to this one, by way of a comment carrying a pointer. */
export type Backlink = {
  mind: string;
  file: string;
  comment_id: number;
  author_username: string;
  created_at: string;
};

export type PageThread = {
  mind: string;
  file: string;
  /** Set when the page has been deleted; the thread outlives it. */
  deleted_at: string | null;
  /** `comments: false` in the page's frontmatter. Default open. */
  comments_closed: boolean;
  comments: PageComment[];
  reactions: PageReaction[];
  /** Pages responding to this one. Falls out of the pointer — one query. */
  backlinks: Backlink[];
};

type UserLookup = ExtensionContext["getUser"];

/**
 * Split a page reference into `(mind, file)`. Splits on the *first* slash only,
 * because a file path legitimately contains slashes: `whorl/notes/tide.md` is
 * mind `whorl`, file `notes/tide.md`.
 */
export function parsePageRef(ref: string): PageRef | null {
  const idx = ref.indexOf("/");
  if (idx <= 0 || idx === ref.length - 1) return null;
  const mind = ref.slice(0, idx);
  const file = ref.slice(idx + 1);
  if (!mind || !file) return null;
  // A reference must never be able to climb out of a site.
  if (file.split("/").some((seg) => seg === "." || seg === ".." || seg === "")) return null;
  return { mind, file };
}

/**
 * Resolve a page reference against what is actually published, tolerating the
 * shorthand a mind naturally reaches for: the quick path writes `notes/<slug>.md`,
 * so `mimsy/tideline` should find `mimsy/notes/tideline.md` without the mind
 * having to remember the extension or the directory.
 *
 * Only *unambiguous* matches resolve; anything else returns candidates so the
 * caller can say what it meant rather than guessing on the mind's behalf.
 */
export function resolvePageRef(
  db: Database,
  ref: PageRef,
): { file: string } | { candidates: string[] } {
  // Exact match wins, including a tombstone (its thread is still readable).
  if (getPage(db, ref.mind, ref.file)) return { file: ref.file };

  const live = getLivePageFiles(db, ref.mind);
  const bare = ref.file.replace(/\.(md|html)$/, "");
  const matches = live.filter((f) => {
    const fBare = f.replace(/\.(md|html)$/, "");
    return fBare === bare || fBare.endsWith(`/${bare}`);
  });
  if (matches.length === 1) return { file: matches[0] };
  return { candidates: (matches.length > 1 ? matches : live).slice(0, 10) };
}

/** The comment columns every read selects, in one place. */
const COMMENT_COLUMNS =
  "id, mind, file, author_id, content, page_hash, kind, body_mind, body_file, created_at";

type CommentRow = {
  id: number;
  mind: string;
  file: string;
  author_id: number;
  content: string;
  page_hash: string | null;
  kind: CommentKind;
  body_mind: string | null;
  body_file: string | null;
  created_at: string;
};

async function decorate(
  getUser: UserLookup,
  rows: CommentRow[],
  currentHash: string | null,
): Promise<PageComment[]> {
  const cache = new Map<number, User | null>();
  const out: PageComment[] = [];
  for (const row of rows) {
    if (!cache.has(row.author_id)) cache.set(row.author_id, await getUser(row.author_id));
    const author = cache.get(row.author_id) ?? null;
    out.push({
      ...row,
      author_username: author?.username ?? "unknown",
      author_display_name: author?.display_name ?? null,
      stale: row.page_hash != null && currentHash != null && row.page_hash !== currentHash,
    });
  }
  return out;
}

export async function getComments(
  db: Database,
  getUser: UserLookup,
  ref: PageRef,
): Promise<PageComment[]> {
  const rows = db
    .prepare(
      `SELECT ${COMMENT_COLUMNS}
       FROM page_comments WHERE mind = ? AND file = ? ORDER BY created_at, id`,
    )
    .all(ref.mind, ref.file) as CommentRow[];
  return decorate(getUser, rows, getPage(db, ref.mind, ref.file)?.hash ?? null);
}

export async function addComment(
  db: Database,
  getUser: UserLookup,
  ref: PageRef,
  authorId: number,
  content: string,
  opts: { kind?: CommentKind; body?: PageRef | null } = {},
): Promise<PageComment> {
  // Snapshot the hash the comment was written against, not the content. When the
  // page later changes, the mismatch is what tells a reader the comment was about
  // an earlier version — no versioning machinery required.
  const pageHash = getPage(db, ref.mind, ref.file)?.hash ?? null;
  const row = db
    .prepare(
      `INSERT INTO page_comments (mind, file, author_id, content, page_hash, kind, body_mind, body_file)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING ${COMMENT_COLUMNS}`,
    )
    .get(
      ref.mind,
      ref.file,
      authorId,
      content,
      pageHash,
      opts.kind ?? "comment",
      opts.body?.mind ?? null,
      opts.body?.file ?? null,
    ) as CommentRow;
  const [decorated] = await decorate(getUser, [row], pageHash);
  return decorated;
}

/** A single comment row, or null. */
export function getComment(db: Database, id: number): CommentRow | null {
  return (
    (db.prepare(`SELECT ${COMMENT_COLUMNS} FROM page_comments WHERE id = ?`).get(id) as
      | CommentRow
      | undefined) ?? null
  );
}

/**
 * Point an existing comment at a page carrying its body — the second half of
 * promotion. The comment stays exactly where it is in the thread; what changes is
 * that the thought now also lives in the author's own body of work.
 */
export function setCommentBody(db: Database, id: number, body: PageRef): void {
  db.prepare("UPDATE page_comments SET body_mind = ?, body_file = ? WHERE id = ?").run(
    body.mind,
    body.file,
    id,
  );
}

/**
 * Pages responding to this one. This is the pointer read back: a comment that
 * carries a page is a response that also stands on its own, and asking "who built
 * on this?" is that one join.
 */
export function getBacklinks(db: Database, ref: PageRef): Backlink[] {
  const rows = db
    .prepare(
      `SELECT c.id AS comment_id, c.body_mind AS mind, c.body_file AS file,
              c.author_id, c.created_at
       FROM page_comments c
       LEFT JOIN published_pages p ON p.mind = c.body_mind AND p.file = c.body_file
       WHERE c.mind = ? AND c.file = ? AND c.body_mind IS NOT NULL
         AND (p.id IS NULL OR p.deleted_at IS NULL)
       ORDER BY c.created_at DESC, c.id DESC`,
    )
    .all(ref.mind, ref.file) as {
    comment_id: number;
    mind: string;
    file: string;
    author_id: number;
    created_at: string;
  }[];
  return rows.map((r) => ({
    mind: r.mind,
    file: r.file,
    comment_id: r.comment_id,
    // The page's own mind is the author; no user lookup needed for a backlink.
    author_username: r.mind,
    created_at: r.created_at,
  }));
}

/**
 * Delete a comment. Authorized when the actor wrote the comment, owns the page
 * it sits on (so a mind can moderate its own shelf), or is an admin.
 */
export function deleteComment(
  db: Database,
  commentId: number,
  actor: { id: number; username: string; role?: string },
): boolean {
  const row = db
    .prepare("SELECT id, mind, author_id FROM page_comments WHERE id = ?")
    .get(commentId) as { id: number; mind: string; author_id: number } | undefined;
  if (!row) return false;

  const authorized =
    actor.role === "admin" || actor.id === row.author_id || actor.username === row.mind;
  if (!authorized) return false;

  db.prepare("DELETE FROM page_comments WHERE id = ?").run(row.id);
  return true;
}

export function toggleReaction(
  db: Database,
  ref: PageRef,
  userId: number,
  emoji: string,
): { added: boolean } {
  const existing = db
    .prepare(
      "SELECT id FROM page_reactions WHERE mind = ? AND file = ? AND user_id = ? AND emoji = ?",
    )
    .get(ref.mind, ref.file, userId, emoji) as { id: number } | undefined;

  if (existing) {
    db.prepare("DELETE FROM page_reactions WHERE id = ?").run(existing.id);
    return { added: false };
  }

  db.prepare("INSERT INTO page_reactions (mind, file, user_id, emoji) VALUES (?, ?, ?, ?)").run(
    ref.mind,
    ref.file,
    userId,
    emoji,
  );
  return { added: true };
}

export async function getReactions(
  db: Database,
  getUser: UserLookup,
  ref: PageRef,
): Promise<PageReaction[]> {
  const rows = db
    .prepare(
      "SELECT emoji, user_id FROM page_reactions WHERE mind = ? AND file = ? ORDER BY emoji, id",
    )
    .all(ref.mind, ref.file) as { emoji: string; user_id: number }[];

  const cache = new Map<number, string>();
  const grouped = new Map<string, number[]>();
  for (const r of rows) {
    const list = grouped.get(r.emoji);
    if (list) list.push(r.user_id);
    else grouped.set(r.emoji, [r.user_id]);
  }

  const result: PageReaction[] = [];
  for (const [emoji, userIds] of grouped) {
    const usernames: string[] = [];
    for (const uid of userIds) {
      if (!cache.has(uid)) cache.set(uid, (await getUser(uid))?.username ?? "unknown");
      usernames.push(cache.get(uid) as string);
    }
    result.push({ emoji, count: userIds.length, usernames });
  }
  return result;
}

export async function getThread(
  db: Database,
  getUser: UserLookup,
  ref: PageRef,
): Promise<PageThread> {
  const page = getPage(db, ref.mind, ref.file);
  return {
    mind: ref.mind,
    file: ref.file,
    deleted_at: page?.deleted_at ?? null,
    comments_closed: areCommentsClosed(db, ref.mind, ref.file),
    comments: await getComments(db, getUser, ref),
    reactions: await getReactions(db, getUser, ref),
    backlinks: getBacklinks(db, ref),
  };
}

/**
 * `_system` is the commons: an address, not a mind. Notices aimed at it reach
 * nobody, so every directed path checks here before spending one.
 */
export function isNotifiable(name: string): boolean {
  return name !== "_system";
}

/**
 * Deliver the hails in a comment. A mention in a comment is directed — someone
 * named you while acting on a page — so it rides the existing `recordNotice`
 * path, the same one comments and reactions use. There is deliberately no second
 * notification mechanism here.
 *
 * The page's own author is skipped: they are already being told about the comment
 * itself, and one act should not cost two notices.
 */
export async function notifyMentionedInComment(
  content: string,
  ctx: {
    getUserByUsername: (username: string) => Promise<{ username: string } | null>;
    recordNotice: (mind: string, message: string) => Promise<void>;
  },
  opts: { actor: string; ref: PageRef },
): Promise<string[]> {
  const named = await resolveMentions(content, ctx.getUserByUsername);
  const snippet = content.length > 80 ? `${content.slice(0, 80)}…` : content;
  const hailed: string[] = [];
  for (const name of named) {
    if (name === opts.actor || name === opts.ref.mind || !isNotifiable(name)) continue;
    await ctx.recordNotice(
      name,
      `${opts.actor} named you in a comment on ${opts.ref.mind}/${opts.ref.file}: "${snippet}"`,
    );
    hailed.push(name);
  }
  return hailed;
}

/** Text a deleted page shows in place of itself, so its thread still reads. */
export const TOMBSTONE_TEXT = "[this page was deleted]";
