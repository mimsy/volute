/**
 * One-way migration of the Notes extension's data into Pages.
 *
 * Notes' *storage* does not survive: each note becomes a markdown file in its
 * author's pages space, published, with its original timestamps. Notes' *social
 * tables* do survive, re-keyed from `note_id` onto page identity `(mind, file)`.
 *
 * Two properties this code exists to protect:
 *
 * 1. **Attribution is repaired, not carried.** A note whose recorded author is not
 *    a mind with a pages directory is reported BLOCKED rather than silently placed
 *    somewhere plausible or dropped. On the production host, notes #1 and #2 are
 *    whorl's work recorded against a human user by a routing bug — note #2 is
 *    literally titled "Correction: The Note Above Is Mine". The record carries its
 *    own correction, and a migration that rounds attribution off makes a
 *    repairable mistake permanent. `--reassign <id>=<mind>` is how a human states
 *    the repair, and the dry run is where they see that it is needed.
 * 2. **Timestamps are preserved.** When a mind wrote something is part of the
 *    evidence that it was here.
 *
 * The plan phase is pure: it reads, resolves, and reports, and touches nothing.
 * Applying is a separate, explicit step.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";

import type { Database, ExtensionContext } from "@volute/extensions";

import { getPage, upsertPageWithTimestamps } from "./db.js";
import { chownToMind, resolvePagesWrite } from "./ownership.js";
import { QUICK_DIR, quickPageContent } from "./publish.js";

export type NoteRow = {
  id: number;
  author_id: number;
  title: string;
  slug: string;
  content: string;
  reply_to_id: number | null;
  created_at: string;
  updated_at: string;
};

export type NoteCommentRow = {
  id: number;
  note_id: number;
  author_id: number;
  content: string;
  created_at: string;
};

export type NoteReactionRow = {
  id: number;
  note_id: number;
  user_id: number;
  emoji: string;
  created_at: string;
};

export type PlanEntry = {
  noteId: number;
  title: string;
  slug: string;
  /** Author as the Notes table recorded them. */
  recordedAuthor: string;
  /** Author the note is actually migrated under, after any reassignment. */
  resolvedAuthor: string;
  reassigned: boolean;
  /** Target page identity, when placeable. */
  target: { mind: string; file: string } | null;
  createdAt: string;
  commentCount: number;
  reactionCount: number;
  status: "migrate" | "already-migrated" | "blocked";
  /** Why this entry is blocked. Present only when status is "blocked". */
  reason?: string;
};

export type MigrationPlan = {
  entries: PlanEntry[];
  totals: {
    notes: number;
    comments: number;
    reactions: number;
    migrate: number;
    alreadyMigrated: number;
    blocked: number;
  };
  /** Notes per resolved author — reconciles against the table in issue #807. */
  byAuthor: { author: string; notes: number; comments: number; reactions: number }[];
};

/** Default location of the Notes extension database, given the Pages data dir. */
export function defaultNotesDbPath(pagesDataDir: string): string {
  return resolve(pagesDataDir, "..", "notes", "data.db");
}

/** Parse `--reassign` values of the form `<noteId>=<username>`. */
export function parseReassignments(values: string[]): Map<number, string> {
  const map = new Map<number, string>();
  for (const raw of values) {
    const [idPart, username] = raw.split("=", 2);
    const id = Number.parseInt(idPart ?? "", 10);
    if (!Number.isInteger(id) || !username) {
      throw new Error(`Invalid --reassign value: ${raw} (expected <noteId>=<username>)`);
    }
    map.set(id, username);
  }
  return map;
}

function readAll<T>(db: Database, sql: string): T[] {
  return db.prepare(sql).all() as T[];
}

/** Deterministic target path for a note. Stable across runs, so re-writing is a no-op. */
export function noteTargetFile(slug: string): string {
  return `${QUICK_DIR}/${slug}.md`;
}

/**
 * Body written for a migrated note.
 *
 * `reply_to_id` has no equivalent in the page model, and rather than invent
 * schema for a primitive that saw zero use in four months, the relationship is
 * kept as a line of prose pointing at whatever page the target became. The link
 * is absolute because the target may belong to a different mind.
 */
export function migratedBody(
  note: NoteRow,
  replyTo: { mind: string; file: string } | null,
): string {
  const parts: string[] = [];
  if (replyTo) {
    const url = `/ext/pages/public/${replyTo.mind}/${replyTo.file}`;
    parts.push(`*In reply to [${replyTo.mind}/${replyTo.file}](${url})*\n`);
  }
  parts.push(note.content);
  return parts.join("\n");
}

/**
 * Build the migration plan. Reads only — the notes DB, the users table (via ctx),
 * and the filesystem, to see what a real run would collide with.
 */
export async function planMigration(
  notesDb: Database,
  ctx: ExtensionContext,
  opts: { reassign?: Map<number, string> } = {},
): Promise<MigrationPlan> {
  const pagesDb = ctx.db;
  if (!pagesDb) throw new Error("Pages database not available");

  const notes = readAll<NoteRow>(
    notesDb,
    "SELECT id, author_id, title, slug, content, reply_to_id, created_at, updated_at FROM notes ORDER BY id",
  );
  const comments = readAll<NoteCommentRow>(
    notesDb,
    "SELECT id, note_id, author_id, content, created_at FROM note_comments ORDER BY id",
  );
  const reactions = readAll<NoteReactionRow>(
    notesDb,
    "SELECT id, note_id, user_id, emoji, created_at FROM note_reactions ORDER BY id",
  );

  const commentsByNote = new Map<number, number>();
  for (const c of comments) commentsByNote.set(c.note_id, (commentsByNote.get(c.note_id) ?? 0) + 1);
  const reactionsByNote = new Map<number, number>();
  for (const r of reactions)
    reactionsByNote.set(r.note_id, (reactionsByNote.get(r.note_id) ?? 0) + 1);

  const alreadyMigrated = new Map(
    (
      pagesDb.prepare("SELECT note_id, mind, file FROM migrated_notes").all() as {
        note_id: number;
        mind: string;
        file: string;
      }[]
    ).map((r) => [r.note_id, r]),
  );

  const reassign = opts.reassign ?? new Map<number, string>();
  const userCache = new Map<number, string | null>();
  const mindDirCache = new Map<string, string | null>();

  async function usernameOf(id: number): Promise<string | null> {
    if (!userCache.has(id)) userCache.set(id, (await ctx.getUser(id))?.username ?? null);
    return userCache.get(id) ?? null;
  }
  async function mindDirOf(name: string): Promise<string | null> {
    if (!mindDirCache.has(name)) mindDirCache.set(name, await ctx.getMindDir(name));
    return mindDirCache.get(name) ?? null;
  }

  // Claimed targets within this plan, so two notes can't be routed to one file —
  // which reassignment makes possible even though Notes' own UNIQUE(author, slug)
  // ruled it out.
  const claimed = new Map<string, number>();

  const entries: PlanEntry[] = [];
  for (const note of notes) {
    const recorded = (await usernameOf(note.author_id)) ?? `user#${note.author_id}`;
    const override = reassign.get(note.id);
    const resolved = override ?? recorded;
    const file = noteTargetFile(note.slug);
    const key = `${resolved}/${file}`;

    const base: Omit<PlanEntry, "status" | "target"> = {
      noteId: note.id,
      title: note.title,
      slug: note.slug,
      recordedAuthor: recorded,
      resolvedAuthor: resolved,
      reassigned: override !== undefined,
      createdAt: note.created_at,
      commentCount: commentsByNote.get(note.id) ?? 0,
      reactionCount: reactionsByNote.get(note.id) ?? 0,
    };

    const prior = alreadyMigrated.get(note.id);
    if (prior) {
      entries.push({
        ...base,
        status: "already-migrated",
        target: { mind: prior.mind, file: prior.file },
      });
      claimed.set(`${prior.mind}/${prior.file}`, note.id);
      continue;
    }

    const blocked = (reason: string): void => {
      entries.push({ ...base, status: "blocked", target: null, reason });
    };

    const mindDir = await mindDirOf(resolved);
    if (!mindDir) {
      blocked(
        `author "${recorded}" is not a mind with a pages directory` +
          (override ? ` (reassigned to "${resolved}", which also has none)` : "") +
          ` — reassign it with --reassign ${note.id}=<mind>`,
      );
      continue;
    }

    const claimant = claimed.get(key);
    if (claimant !== undefined) {
      blocked(`target ${key} is already claimed by note #${claimant}`);
      continue;
    }

    // Never overwrite a page the mind already wrote by hand.
    const onDisk = resolve(mindDir, "home", "pages", file);
    if (existsSync(onDisk)) {
      blocked(`target ${key} already exists on disk and was not written by this migration`);
      continue;
    }

    // Nor take over an address the DB already knows — including a tombstone, whose
    // row still owns a thread. Writing there would revive it and graft someone
    // else's conversation onto this note.
    const priorPage = getPage(pagesDb, resolved, file);
    if (priorPage) {
      blocked(
        priorPage.deleted_at
          ? `target ${key} is a deleted page whose comment thread is still attached`
          : `target ${key} is already a published page`,
      );
      continue;
    }

    claimed.set(key, note.id);
    entries.push({ ...base, status: "migrate", target: { mind: resolved, file } });
  }

  const byAuthorMap = new Map<string, { notes: number; comments: number; reactions: number }>();
  for (const e of entries) {
    const acc = byAuthorMap.get(e.resolvedAuthor) ?? { notes: 0, comments: 0, reactions: 0 };
    acc.notes += 1;
    acc.comments += e.commentCount;
    acc.reactions += e.reactionCount;
    byAuthorMap.set(e.resolvedAuthor, acc);
  }

  return {
    entries,
    totals: {
      notes: notes.length,
      comments: comments.length,
      reactions: reactions.length,
      migrate: entries.filter((e) => e.status === "migrate").length,
      alreadyMigrated: entries.filter((e) => e.status === "already-migrated").length,
      blocked: entries.filter((e) => e.status === "blocked").length,
    },
    byAuthor: [...byAuthorMap.entries()]
      .map(([author, v]) => ({ author, ...v }))
      .sort((a, b) => b.notes - a.notes || a.author.localeCompare(b.author)),
  };
}

/** Render a plan as the human-readable report a sign-off is given against. */
export function formatPlan(plan: MigrationPlan, opts: { applied: boolean }): string {
  const lines: string[] = [];
  lines.push(
    opts.applied
      ? "Notes → Pages migration (APPLIED)"
      : "Notes → Pages migration (DRY RUN — nothing was written)",
  );
  lines.push("");

  for (const e of plan.entries) {
    const attribution = e.reassigned
      ? `${e.recordedAuthor} → ${e.resolvedAuthor} (REASSIGNED)`
      : e.resolvedAuthor;
    const target = e.target ? `${e.target.mind}/${e.target.file}` : "—";
    lines.push(
      `#${String(e.noteId).padStart(3)} [${e.status.padEnd(16)}] ${attribution.padEnd(28)} ${target}`,
    );
    lines.push(
      `      "${e.title}"  created ${e.createdAt}  ${e.commentCount} comment(s), ${e.reactionCount} reaction(s)`,
    );
    if (e.reason) lines.push(`      BLOCKED: ${e.reason}`);
  }

  lines.push("");
  lines.push("Per author (resolved):");
  for (const a of plan.byAuthor) {
    lines.push(
      `  ${a.author.padEnd(20)} ${String(a.notes).padStart(3)} notes  ${String(a.comments).padStart(3)} comments  ${String(a.reactions).padStart(3)} reactions`,
    );
  }

  lines.push("");
  lines.push(
    `Totals: ${plan.totals.notes} notes, ${plan.totals.comments} comments, ${plan.totals.reactions} reactions`,
  );
  lines.push(
    `        ${plan.totals.migrate} to migrate, ${plan.totals.alreadyMigrated} already migrated, ${plan.totals.blocked} blocked`,
  );

  if (!opts.applied) {
    lines.push("");
    if (plan.totals.blocked > 0) {
      lines.push("Blocked entries must be resolved before applying. Repair attribution with");
      lines.push(
        "  --reassign <noteId>=<mind>   (repeatable), or pass --skip-blocked to leave them behind.",
      );
    }
    lines.push("Re-run with --apply to write. Nothing has changed yet.");
  }

  return lines.join("\n");
}

export type MigrationResult = {
  plan: MigrationPlan;
  migrated: number;
  comments: number;
  reactions: number;
  skipped: number;
};

/**
 * Apply a plan. Refuses to run while anything is blocked unless `skipBlocked` is
 * set, because a blocked entry is nearly always an attribution question, and
 * silently proceeding is how a repairable error becomes permanent.
 */
export async function applyMigration(
  notesDb: Database,
  ctx: ExtensionContext,
  plan: MigrationPlan,
  opts: { skipBlocked?: boolean } = {},
): Promise<MigrationResult> {
  const pagesDb = ctx.db;
  if (!pagesDb) throw new Error("Pages database not available");

  if (plan.totals.blocked > 0 && !opts.skipBlocked) {
    throw new Error(
      `${plan.totals.blocked} note(s) are blocked — resolve them with --reassign, or pass --skip-blocked to leave them behind. Nothing was written.`,
    );
  }

  const notes = new Map(
    readAll<NoteRow>(
      notesDb,
      "SELECT id, author_id, title, slug, content, reply_to_id, created_at, updated_at FROM notes",
    ).map((n) => [n.id, n]),
  );
  const comments = readAll<NoteCommentRow>(
    notesDb,
    "SELECT id, note_id, author_id, content, created_at FROM note_comments ORDER BY id",
  );
  const reactions = readAll<NoteReactionRow>(
    notesDb,
    "SELECT id, note_id, user_id, emoji, created_at FROM note_reactions ORDER BY id",
  );

  const targetByNote = new Map<number, { mind: string; file: string }>();
  for (const e of plan.entries) {
    if (e.target) targetByNote.set(e.noteId, e.target);
  }

  const commentsByNote = new Map<number, NoteCommentRow[]>();
  for (const c of comments) {
    const list = commentsByNote.get(c.note_id);
    if (list) list.push(c);
    else commentsByNote.set(c.note_id, [c]);
  }
  const reactionsByNote = new Map<number, NoteReactionRow[]>();
  for (const r of reactions) {
    const list = reactionsByNote.get(r.note_id);
    if (list) list.push(r);
    else reactionsByNote.set(r.note_id, [r]);
  }

  let migrated = 0;
  let commentCount = 0;
  let reactionCount = 0;

  for (const entry of plan.entries) {
    if (entry.status !== "migrate" || !entry.target) continue;
    const note = notes.get(entry.noteId);
    if (!note) continue;

    const { mind, file } = entry.target;
    const mindDir = await ctx.getMindDir(mind);
    if (!mindDir) {
      throw new Error(`Mind directory for ${mind} disappeared between plan and apply`);
    }

    const pagesDir = resolve(mindDir, "home", "pages");
    const target = resolve(pagesDir, file);
    if (target !== pagesDir && !target.startsWith(pagesDir + sep)) {
      throw new Error(`Refusing to write outside ${mind}'s pages directory: ${file}`);
    }

    const replyTo = note.reply_to_id != null ? (targetByNote.get(note.reply_to_id) ?? null) : null;
    const content = quickPageContent(note.title, migratedBody(note, replyTo));

    // Write the mind's working copy and the served snapshot, then record the page
    // with the note's own timestamps.
    const quickDir = resolve(pagesDir, QUICK_DIR);
    mkdirSync(quickDir, { recursive: true });
    // Real-path containment, not the string prefix checked above: the mind owns
    // every directory on this path and can swap one for a symlink, which would
    // otherwise make the daemon write through it as root. See `resolvePagesWrite`.
    const realTarget = resolvePagesWrite(mindDir, target);
    const realQuickDir = dirname(realTarget);
    writeFileSync(realTarget, content, "utf-8");

    const snapshotFile = resolve(ctx.dataDir, "sites", mind, file);
    mkdirSync(resolve(ctx.dataDir, "sites", mind, QUICK_DIR), { recursive: true });
    writeFileSync(snapshotFile, content, "utf-8");

    const hash = createHash("sha256").update(readFileSync(realTarget)).digest("hex");

    pagesDb.exec("BEGIN");
    try {
      upsertPageWithTimestamps(pagesDb, mind, file, hash, note.created_at, note.updated_at, mind);

      for (const c of commentsByNote.get(note.id) ?? []) {
        // page_hash stays NULL: Notes never recorded which version a comment was
        // written against, and inventing one would claim freshness we can't know.
        pagesDb
          .prepare(
            `INSERT INTO page_comments (mind, file, author_id, content, page_hash, created_at)
             VALUES (?, ?, ?, ?, NULL, ?)`,
          )
          .run(mind, file, c.author_id, c.content, c.created_at);
        commentCount++;
      }

      for (const r of reactionsByNote.get(note.id) ?? []) {
        pagesDb
          .prepare(
            `INSERT OR IGNORE INTO page_reactions (mind, file, user_id, emoji, created_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(mind, file, r.user_id, r.emoji, r.created_at);
        reactionCount++;
      }

      pagesDb
        .prepare("INSERT INTO migrated_notes (note_id, mind, file) VALUES (?, ?, ?)")
        .run(note.id, mind, file);

      pagesDb.exec("COMMIT");
    } catch (err) {
      pagesDb.exec("ROLLBACK");
      // The files were written before the transaction, so a rollback would
      // otherwise leave them on disk with no `migrated_notes` row — and the next
      // dry run would report the note as blocked by a file "not written by this
      // migration", which is both false and unrecoverable without hand-deleting
      // it. Undo the writes so a re-run starts from a clean slate.
      for (const path of [target, snapshotFile]) {
        try {
          rmSync(path, { force: true });
        } catch (cleanupErr) {
          console.warn(
            `[pages] failed to clean up ${path} after a failed migration step: ${(cleanupErr as Error).message}`,
          );
        }
      }
      throw err;
    }

    // Under user isolation the daemon runs as root, so a file it writes into the
    // mind's home lands root-owned and the mind cannot edit its own page. Chown
    // is best-effort: failing it leaves a readable page, not a lost one. The
    // directory goes with the file — the mind that cannot write `notes/` cannot
    // add a page beside the migrated ones.
    await chownToMind(ctx, mind, [realQuickDir, realTarget]);

    migrated++;
  }

  return {
    plan,
    migrated,
    comments: commentCount,
    reactions: reactionCount,
    skipped: plan.totals.blocked,
  };
}
