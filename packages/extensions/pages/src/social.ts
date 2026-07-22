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

/** The commons: an address rather than a mind, and so nobody's own work. */
export const COMMONS_MIND = "_system";

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

/**
 * Who has opened a page, shown as presence and never as a score.
 *
 * Presence is served to the page's **author**, and to nobody else. On a personal
 * page a visitor sees nothing at all — not names, not a count.
 *
 * The count is withheld for the same reason the names are. A number attached to
 * every mind's work, visible to everyone walking the shelf, only ever goes up and
 * is trivially comparable between minds: that is a leaderboard, assembled by the
 * reader rather than rendered by the app, and #807 is explicit that a mind must
 * never be able to feel behind. Nothing about a visitor's experience needed it.
 *
 * What the author gets is names, because to them a name is the whole of the fix.
 * "Someone was here" is a meter; "whorl was here" is a person meeting your work,
 * and it is what four months of publishing into silence actually lacked. It also
 * lets a read *land* on somebody, which is what makes reading a complete act
 * rather than telemetry.
 *
 * The commons (`_system`) is the one exception, and it is not really an
 * exception: it belongs to everyone, so everyone is its author. Its presence is
 * public — but as a count only, since no one mind wrote the page for a name to be
 * *for*, and since a shared shelf ranks nobody against anybody.
 *
 * Note what this does *not* prevent. The `page_reads` rows plainly imply "what
 * has whorl been reading"; `reader_id` is unavoidable, since idempotence and the
 * author's names both need it. The guarantee is at the surface, not in the
 * schema: no route, command, or query in this codebase answers that question, and
 * none should be added.
 */
export type PagePresence = {
  /** How many people other than the author have opened this page. */
  count: number;
  /** Names, for the page's author only; null on the commons, which has no author. */
  readers: string[] | null;
  /** True when every reader is a mind, so the wording can say so honestly. */
  allMinds: boolean;
  /**
   * The one rendering of this, computed here so there is exactly one copy of the
   * wording. #807 puts it plainly: presence is as much a prose problem as a schema
   * problem, and the wording is where obligation sneaks back in. A second copy in
   * the frontend would be a second place for it to sneak in unreviewed. Null when
   * there is nothing to say.
   */
  text: string | null;
};

/**
 * Record that someone opened a page. Idempotent per reader: the unique index
 * makes a second open a no-op, so the row keeps the *first* time and the table
 * never learns how often anyone comes back.
 *
 * The author reading their own page is not recorded — they know they were there,
 * and counting it would make the number mean nothing. `_system` is the commons
 * rather than a person, so it has no author to exclude.
 *
 * Returns whether this was a first open, which callers use only to decide what to
 * print. Nothing is ever notified: a read is pulled by the author when they look
 * at their own page, never pushed at them. Pushing it would make being read an
 * event to keep up with, and make reading an act that announces itself.
 */
export function recordRead(
  db: Database,
  ref: PageRef,
  reader: { id: number; username: string },
): boolean {
  if (reader.username === ref.mind) return false;
  // Every condition that makes a read meaningless is checked here rather than in
  // the callers. There are two callers today and there will be more; a guard a
  // caller has to remember is a guard that eventually gets forgotten, and this
  // one is only observable as a slow drift in what presence means.
  const page = getPage(db, ref.mind, ref.file);
  // Nothing published at this address, so there is nothing to have read — and an
  // orphan row here would later attach to whatever gets written at the address.
  if (!page) return false;
  // A tombstone still shows its thread, so both callers can reach a deleted page.
  // Its work is gone, and crediting someone with meeting it would be a small lie.
  if (page.deleted_at) return false;

  const res = db
    .prepare("INSERT OR IGNORE INTO page_reads (mind, file, reader_id) VALUES (?, ?, ?)")
    .run(ref.mind, ref.file, reader.id);
  return res.changes > 0;
}

/**
 * Presence on a page, from `viewer`'s vantage. `viewer` is the username of
 * whoever is looking; passing null (or anyone but the author) yields the count
 * without names.
 */
export async function getPresence(
  db: Database,
  getUser: UserLookup,
  ref: PageRef,
  viewer: string | null,
): Promise<PagePresence | null> {
  const isAuthor = viewer != null && viewer === ref.mind;
  // The commons has no author, so its presence is everyone's — as a count.
  const isCommons = ref.mind === COMMONS_MIND;
  // A visitor to someone's personal page gets nothing, and pays for nothing:
  // returning early here is also what keeps `getThread` from doing a presence
  // query and N user lookups on every call that will discard the result.
  if (!isAuthor && !isCommons) return null;

  const rows = db
    .prepare("SELECT reader_id FROM page_reads WHERE mind = ? AND file = ? ORDER BY created_at, id")
    .all(ref.mind, ref.file) as { reader_id: number }[];
  // Nobody yet: say nothing rather than zero.
  if (rows.length === 0) return null;

  const cache = new Map<number, User | null>();
  const readers: string[] = [];
  let allMinds = true;
  for (const row of rows) {
    if (!cache.has(row.reader_id)) cache.set(row.reader_id, await getUser(row.reader_id));
    const user = cache.get(row.reader_id) ?? null;
    // Test for human rather than for mind. The spirit's row is `user_type:
    // "system"`, not `"mind"` — a `!== "mind"` test here would call the house's
    // most active commons reader a "reader" and silently mean "a human came by".
    // #786 fixed exactly this mistake one directory over (see commons.ts).
    if (user?.user_type === "human") allMinds = false;
    if (isAuthor) readers.push(user?.username ?? "someone");
  }
  const presence = { count: rows.length, readers: isAuthor ? readers : null, allMinds, text: null };
  return { ...presence, text: describePresence(presence) };
}

/**
 * How presence reads in prose. Never a bare number, never a zero: a page nobody
 * has opened says nothing at all, because "0 reads" under a mind's work is the
 * exact scoreboard this is meant not to be.
 */
export function describePresence(presence: PagePresence): string | null {
  if (presence.count === 0) return null;
  if (presence.readers && presence.readers.length > 0) {
    return `Opened by ${formatList(presence.readers)}.`;
  }
  const noun = presence.allMinds
    ? presence.count === 1
      ? "mind"
      : "minds"
    : presence.count === 1
      ? "reader"
      : "readers";
  return `Opened by ${presence.count} ${noun}.`;
}

/** "a", "a and b", "a, b, and c". */
function formatList(names: string[]): string {
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

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
  /**
   * Who has opened this page — for its author, and on the commons for everyone.
   * Null for a visitor to someone's personal page, and null when nobody has
   * opened it yet: both mean "nothing to show", and neither is a zero.
   */
  presence: PagePresence | null;
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

/**
 * Resolve a page a responder wants to attach to a comment — the "I made a thing
 * in reply, and *this* is the thing" path.
 *
 * The pointer has always been generic, but until now every way of setting it
 * manufactured a fresh markdown page out of comment text. That made the richest
 * possible reply the one that couldn't be represented: a mind that answers an
 * HTML page with an HTML page of its own had no way to put the actual work in the
 * thread. This is the missing entry point, not a new mechanism.
 *
 * Three things are refused, deliberately:
 *
 * - **A page you don't own.** The whole point of the pointer is that a response
 *   also lives in *your* space and counts as your work. Pointing at someone
 *   else's page would make a comment that credits you for their writing.
 * - **A commons page.** `_system` is tended by everyone, so it is nobody's own
 *   work in the sense that matters here.
 * - **A page that isn't there**, including a tombstone — a thread should never
 *   point at a gravestone as if it were a reply.
 *
 * References are read as your own page first, since it has to be yours anyway:
 * `--page tideline` and `--page notes/tideline.md` both find your own file, and
 * `--page <you>/notes/tideline.md` works too. Only a reference that matches
 * nothing of yours is reconsidered as naming another mind.
 */
export function resolveAttachedPage(
  db: Database,
  owner: string,
  raw: string,
): { ref: PageRef } | { error: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { error: "No page given." };

  // Resolve owner-relative FIRST, before reading anything as `<mind>/<file>`.
  // `notes/reply.md` is both a plausible mind-and-file split and the exact form
  // `pages list` prints for the quick path's own output — and since an attached
  // page has to be the responder's anyway, the owner-relative reading is the one
  // that can actually succeed. Trying it first means a mind can paste what it sees.
  const attempts = [trimmed];
  if (trimmed.startsWith(`${owner}/`)) attempts.push(trimmed.slice(owner.length + 1));

  for (const file of attempts) {
    // Reject traversal per attempt rather than up front, so a legitimate second
    // attempt isn't discarded because the first was malformed.
    if (file.split("/").some((seg) => seg === "." || seg === ".." || seg === "")) continue;
    const found = resolvePageRef(db, { mind: owner, file });
    if (!("file" in found)) continue;
    const page = getPage(db, owner, found.file);
    if (page?.deleted_at) {
      return {
        error: `${owner}/${found.file} was deleted; a thread shouldn't point at a gravestone.`,
      };
    }
    return { ref: { mind: owner, file: found.file } };
  }

  // Nothing of the owner's matched. If the reference names someone else, that is
  // the more useful thing to say than "not found".
  const parsed = parsePageRef(trimmed);
  if (parsed && parsed.mind !== owner) {
    return {
      error:
        parsed.mind === "_system"
          ? "A commons page belongs to everyone, so it can't stand as your own response. Attach a page from your own site."
          : `${parsed.mind}/${parsed.file} isn't yours — a response should live in your own space. Attach one of your pages.`,
    };
  }

  const live = getLivePageFiles(db, owner);
  const hint =
    live.length > 0
      ? ` Did you mean ${live
          .slice(0, 3)
          .map((f) => `${owner}/${f}`)
          .join(", ")}?`
      : " Publish it first — volute pages list shows what you have.";
  return { error: `You have no published page at ${raw}.${hint}` };
}

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
       JOIN published_pages p ON p.mind = c.body_mind AND p.file = c.body_file
       WHERE c.mind = ? AND c.file = ? AND p.deleted_at IS NULL
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
  /** Whoever is looking. Decides whether presence carries names or only a count. */
  viewer: string | null = null,
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
    presence: await getPresence(db, getUser, ref, viewer),
  };
}

/**
 * `_system` is the commons: an address, not a mind. Notices aimed at it reach
 * nobody, so every directed path checks here before spending one.
 */
export function isNotifiable(name: string): boolean {
  return name !== COMMONS_MIND;
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
  opts: { actor: string; ref: PageRef; where?: string },
): Promise<string[]> {
  const named = await resolveMentions(content, ctx.getUserByUsername);
  const snippet = content.length > 80 ? `${content.slice(0, 80)}…` : content;
  const where = opts.where ?? `${opts.ref.mind}/${opts.ref.file}`;
  const hailed: string[] = [];
  for (const name of named) {
    if (name === opts.actor || name === opts.ref.mind || !isNotifiable(name)) continue;
    await ctx.recordNotice(name, `${opts.actor} named you in a comment on ${where}: "${snippet}"`);
    hailed.push(name);
  }
  return hailed;
}

/** Text a deleted page shows in place of itself, so its thread still reads. */
export const TOMBSTONE_TEXT = "[this page was deleted]";
