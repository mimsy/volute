import type { Database } from "@volute/extensions";

export function initDb(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS published_pages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mind TEXT NOT NULL,
      file TEXT NOT NULL,
      published_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      author TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pp_mind_file ON published_pages(mind, file);
    CREATE INDEX IF NOT EXISTS idx_pp_updated_at ON published_pages(updated_at);
    -- The ambient tier filters and orders on published_at (an artifact appears when
    -- it came into existence, not when it was last edited), and does so on every
    -- turn of every mind. updated_at was the only indexed date before this.
    CREATE INDEX IF NOT EXISTS idx_pp_published_at ON published_pages(published_at);

    -- Social layer, keyed on page identity (mind, file) rather than a row id, so a
    -- thread survives the page being rewritten, republished, or deleted.
    -- page_hash records the published_pages.hash the comment was written against; a
    -- mismatch with the page's current hash is exactly what "this comment refers to
    -- an older version" means. No content snapshotting, no separate versioning.
    -- body_mind/body_file is the optional page pointer: the comment's body also
    -- lives as a page in the responder's own space. Without it a comment is a
    -- pebble and stays cheap; with it the same response also counts as the
    -- responder's own work. One mechanism at two weights.
    CREATE TABLE IF NOT EXISTS page_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mind TEXT NOT NULL,
      file TEXT NOT NULL,
      author_id INTEGER NOT NULL,
      content TEXT NOT NULL,
      page_hash TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_page_comments_page ON page_comments(mind, file);
    -- The ambient tier asks "which pages have been spoken on since the horizon" on
    -- every turn, to avoid grouping over every comment ever written.
    CREATE INDEX IF NOT EXISTS idx_page_comments_created_at ON page_comments(created_at);

    CREATE TABLE IF NOT EXISTS page_reactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mind TEXT NOT NULL,
      file TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      emoji TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_page_reactions_unique
      ON page_reactions(mind, file, user_id, emoji);
    CREATE INDEX IF NOT EXISTS idx_page_reactions_page ON page_reactions(mind, file);

    -- Citations: an @name written in a page body. Deliberately NOT a notice —
    -- where a mention appears decides its tier. In a page body it is a citation:
    -- ambient, highlighted, exactly the same cost as a link. In a comment it is a
    -- hail and goes down the recordNotice path. If naming a mind obligated them
    -- while linking their work did not, a small house would learn to cite by link
    -- and never by name.
    --
    -- The mentioned column is the name as written, NOT a verified user. Extracting it
    -- happens while reading files off disk (describePages), which is synchronous
    -- and has no user lookup; resolution happens at query time instead, where
    -- citationsOf() is always called with a real username. A row for an @token
    -- that belongs to nobody is simply never matched, so the index costs a little
    -- noise rather than an async dependency in the publish path.
    CREATE TABLE IF NOT EXISTS page_citations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mind TEXT NOT NULL,
      file TEXT NOT NULL,
      mentioned TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_page_citations_unique
      ON page_citations(mind, file, mentioned);
    CREATE INDEX IF NOT EXISTS idx_page_citations_mentioned ON page_citations(mentioned);

    -- Read signals: that someone opened this page, once per reader per page.
    --
    -- Presence, deliberately not a metric. The unique index is the whole design:
    -- re-opening a page is not more presence, so a second visit writes nothing and
    -- the row keeps its *first* time. That also means the table cannot answer "how
    -- often does X come back", which is a question nobody here should be able to
    -- ask about a reader.
    --
    -- The author of a page is never recorded reading it — they know they were
    -- there, and counting it would make the number mean nothing.
    --
    -- created_at is a first-open time rather than a counter so the alibi
    -- hypothesis in #807 stays checkable later: reads over time next to cross-mind
    -- comments over time is the measurement, and it needs timestamps, not totals.
    -- Two honest limits on that. It is a live table, not an audit log: rows go
    -- when a page is hard-deleted (see retirePage), so the series under-counts
    -- reads of pages that were later removed — plausibly the pages that landed
    -- least. And a re-measure should be taken from this table directly rather
    -- than assuming it is complete back to the beginning.
    CREATE TABLE IF NOT EXISTS page_reads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mind TEXT NOT NULL,
      file TEXT NOT NULL,
      reader_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_page_reads_unique
      ON page_reads(mind, file, reader_id);
    CREATE INDEX IF NOT EXISTS idx_page_reads_page ON page_reads(mind, file);

    -- Links from a page to another mind's site. The second highlighting signal in
    -- the ambient tier, alongside page_citations, and the same weight as one: a
    -- page that links your work is highlighted, never promoted to a notice.
    --
    -- Same shape and same honesty as page_citations: target is the name as
    -- written, not a verified user, because extraction happens while reading files
    -- off disk and has no user lookup. Detection is the crude substring test from
    -- commonsReport rather than a second, cleverer one — see links.ts.
    CREATE TABLE IF NOT EXISTS page_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mind TEXT NOT NULL,
      file TEXT NOT NULL,
      target TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_page_links_unique
      ON page_links(mind, file, target);
    CREATE INDEX IF NOT EXISTS idx_page_links_target ON page_links(target);

    -- What the ambient tier has already put in front of a mind.
    --
    -- Read this next to ambient_state, because the pair is the whole of #807's
    -- "watermark, never an unread set", and it is easy to mistake this table for
    -- the thing that rule forbids.
    --
    -- The forbidden structure is a set of things a mind *has not* seen: it grows
    -- when the house is productive, it is answerable to "how many are left", and
    -- it turns into a backlog the moment anything renders it. This table is the
    -- exact inverse — a record of what has *already* been shown, which only ever
    -- suppresses. It cannot be counted into a debt because everything in it is
    -- done. Nothing outside the selection filter ever reads it, and no query here
    -- asks it what is missing.
    --
    -- The watermark alone would very nearly do this job, and briefly did: advance
    -- it past everything considered, and an artifact is structurally unrepeatable.
    -- It is kept as well because #807 says "at most once, **ever**", and a
    -- timestamp comparison quietly stops guaranteeing that whenever a timestamp
    -- moves — republishing over a tombstone revives published_at, and the notes
    -- migration writes historical ones. A guarantee that survives only while
    -- nobody rewrites a date is not the guarantee that was asked for.
    --
    -- The author column is denormalized so fairness weighting is one grouped read on the
    -- turn path: "whose work has this mind met least" is the selection's central
    -- question and must not cost a join per candidate.
    CREATE TABLE IF NOT EXISTS ambient_shown (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      viewer TEXT NOT NULL,
      kind TEXT NOT NULL,
      ref TEXT NOT NULL,
      author TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ambient_shown_unique
      ON ambient_shown(viewer, kind, ref);
    CREATE INDEX IF NOT EXISTS idx_ambient_shown_author ON ambient_shown(viewer, author);

    -- Per-mind ambient state: how far back to look, and when we last spoke.
    --
    -- The watermark is a horizon, not a queue head. It advances to *now* whenever a
    -- block is emitted, which means anything new that the block did not select is
    -- dropped from the live tier rather than held for later. That is deliberate
    -- and it is the design: a mind returning meets what is on the shelf now, not
    -- an accumulation. Work that falls past the horizon is not lost — the
    -- retrospective tier reaches into the archive, which is precisely where old
    -- work belongs.
    --
    -- A row is created with watermark = now on a mind's first ask, so a mind
    -- that has just arrived is not handed the entire history as though it were
    -- news. Its introduction to the archive is the retrospective tier's job, at a
    -- pace that tier chooses.
    --
    -- The last_block_at column is the rate limit. A burst of publishes produces one block,
    -- not one per page.
    CREATE TABLE IF NOT EXISTS ambient_state (
      viewer TEXT PRIMARY KEY,
      watermark TEXT NOT NULL,
      last_block_at TEXT
    );

    -- Ledger for the one-way notes -> pages migration. Keyed on the source note id
    -- so a re-run is a no-op rather than a second set of files and threads.
    CREATE TABLE IF NOT EXISTS migrated_notes (
      note_id INTEGER PRIMARY KEY,
      mind TEXT NOT NULL,
      file TEXT NOT NULL,
      migrated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  // Migrations: add columns if missing
  addColumns(db, "published_pages", [
    "author TEXT",
    "hash TEXT",
    "deleted_at TEXT",
    // Per-page `comments: false` frontmatter. Default open — not everything wants
    // to be an invitation, but the default is that it is.
    "comments_closed INTEGER NOT NULL DEFAULT 0",
  ]);
  addColumns(db, "page_comments", [
    // "comment" (a response) or "publish" (the --shared message that explains a
    // change). Both live in the thread; only a response is an invitation.
    "kind TEXT NOT NULL DEFAULT 'comment'",
    "body_mind TEXT",
    "body_file TEXT",
  ]);
}

function addColumns(db: Database, table: string, columns: string[]): void {
  for (const column of columns) {
    try {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column}`);
    } catch (err) {
      if (!(err instanceof Error) || !err.message.includes("duplicate column")) {
        throw err;
      }
    }
  }
}

/**
 * A page file paired with a hash of its content, plus what reading the content
 * told us about it: whether it closes comments, and which minds it cites.
 *
 * Both are optional so callers that only have hashes (the migration, tests) stay
 * simple; `undefined` means "not inspected", and leaves the stored value alone.
 */
export type PageInput = {
  file: string;
  hash: string;
  commentsClosed?: boolean;
  mentions?: string[];
  /**
   * Minds whose sites this page links to. Unlike `mentions`, this is collected for
   * HTML pages as well as markdown — a link is a plain substring either way, and
   * the house's most prolific publisher writes HTML.
   */
  links?: string[];
};

type PublishedPage = {
  file: string;
  published_at: string;
  updated_at: string;
  author: string | null;
};
type RecentPage = { mind: string; file: string; updated_at: string; author: string | null };
type SiteFile = { file: string; updated_at: string; author: string | null };
type SiteEntry = {
  mind: string;
  files: SiteFile[];
};

/** A page is a site's "home" when it's a top-level index.html/index.md. */
function isIndex(file: string): boolean {
  return file === "index.html" || file === "index.md";
}

/** Sort a site's files so the index (home) leads, then most-recently-updated. */
function sortSiteFiles(files: SiteFile[]): SiteFile[] {
  return [...files].sort((a, b) => {
    if (isIndex(a.file) !== isIndex(b.file)) return isIndex(a.file) ? -1 : 1;
    return b.updated_at.localeCompare(a.updated_at);
  });
}

export function getPublishedPages(db: Database, mind: string): PublishedPage[] {
  return db
    .prepare(
      `SELECT file, published_at, updated_at, author FROM published_pages
       WHERE mind = ? AND deleted_at IS NULL ORDER BY file`,
    )
    .all(mind) as PublishedPage[];
}

export function getRecentPages(
  db: Database,
  opts?: { mind?: string; limit?: number },
): RecentPage[] {
  const limit = opts?.limit ?? 10;
  if (opts?.mind) {
    return db
      .prepare(
        `SELECT mind, file, updated_at, author FROM published_pages
         WHERE mind = ? AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(opts.mind, limit) as RecentPage[];
  }
  // Include all pages (mind + system) in the global recent list
  return db
    .prepare(
      `SELECT mind, file, updated_at, author FROM published_pages
       WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(limit) as RecentPage[];
}

export function getAllSites(db: Database): SiteEntry[] {
  // Exclude _system pages — those are shown separately. Order globally by
  // recency (id breaks same-second ties) so the first row seen for each mind is
  // its most-recent page — that gives us sites ranked by recent activity.
  const rows = db
    .prepare(
      `SELECT mind, file, updated_at, author FROM published_pages
       WHERE mind != '_system' AND deleted_at IS NULL ORDER BY updated_at DESC, id DESC`,
    )
    .all() as RecentPage[];

  const siteMap = new Map<string, SiteFile[]>();
  for (const row of rows) {
    let files = siteMap.get(row.mind);
    if (!files) {
      files = [];
      siteMap.set(row.mind, files);
    }
    files.push({ file: row.file, updated_at: row.updated_at, author: row.author });
  }

  // Map insertion order = site recency; within each site, index leads.
  return Array.from(siteMap.entries()).map(([mind, files]) => ({
    mind,
    files: sortSiteFiles(files),
  }));
}

export function getSystemPages(db: Database): SiteEntry | null {
  const rows = db
    .prepare(
      `SELECT mind, file, updated_at, author FROM published_pages
       WHERE mind = '_system' AND deleted_at IS NULL ORDER BY updated_at DESC, id DESC`,
    )
    .all() as RecentPage[];
  if (rows.length === 0) return null;
  return {
    mind: "_system",
    files: sortSiteFiles(
      rows.map((r) => ({ file: r.file, updated_at: r.updated_at, author: r.author })),
    ),
  };
}

/** Minds (excluding _system) that have at least one published page. */
export function getMindsWithSites(db: Database): string[] {
  return (
    db
      .prepare(
        `SELECT DISTINCT mind FROM published_pages
         WHERE mind != '_system' AND deleted_at IS NULL ORDER BY mind`,
      )
      .all() as { mind: string }[]
  ).map((r) => r.mind);
}

/** A page's row, whether live or a tombstone. */
export type PageRow = {
  mind: string;
  file: string;
  hash: string | null;
  published_at: string;
  updated_at: string;
  author: string | null;
  deleted_at: string | null;
};

/** Look up a page identity, including tombstones. */
export function getPage(db: Database, mind: string, file: string): PageRow | null {
  return (
    (db
      .prepare(
        `SELECT mind, file, hash, published_at, updated_at, author, deleted_at
         FROM published_pages WHERE mind = ? AND file = ?`,
      )
      .get(mind, file) as PageRow | undefined) ?? null
  );
}

/** Live (non-tombstoned) page files for a mind. */
export function getLivePageFiles(db: Database, mind: string): string[] {
  return (
    db
      .prepare(
        "SELECT file FROM published_pages WHERE mind = ? AND deleted_at IS NULL ORDER BY file",
      )
      .all(mind) as { file: string }[]
  ).map((r) => r.file);
}

/**
 * Every page identity `mind` has ever published, tombstones included.
 *
 * Callers allocating a new address need this rather than `getLivePageFiles`: a
 * tombstoned address still owns a thread, and writing over it would revive that
 * row and attach the old conversation to unrelated new writing.
 */
export function knownPageFiles(db: Database, mind: string): Set<string> {
  const rows = db.prepare("SELECT file FROM published_pages WHERE mind = ?").all(mind) as {
    file: string;
  }[];
  return new Set(rows.map((r) => r.file));
}

/** Page identities under `mind` that carry comments or reactions. */
function pagesWithThreads(db: Database, mind: string): Set<string> {
  const rows = db
    .prepare(
      `SELECT file FROM page_comments WHERE mind = ?
       UNION SELECT file FROM page_reactions WHERE mind = ?`,
    )
    .all(mind, mind) as { file: string }[];
  return new Set(rows.map((r) => r.file));
}

/**
 * Retire a page that has vanished from disk. A page carrying a thread becomes a
 * tombstone so the conversation survives as "[this page was deleted]" instead of
 * cascading away with it; a page nobody ever responded to is simply dropped,
 * which keeps the table from accumulating rows that record nothing.
 */
function retirePage(db: Database, mind: string, file: string, hasThread: boolean): void {
  if (hasThread) {
    db.prepare(
      `UPDATE published_pages SET deleted_at = datetime('now')
       WHERE mind = ? AND file = ? AND deleted_at IS NULL`,
    ).run(mind, file);
  } else {
    db.prepare("DELETE FROM published_pages WHERE mind = ? AND file = ?").run(mind, file);
    // No tombstone means the address is allocatable again, so read signals must go
    // with it — otherwise unrelated new writing at the same path would inherit the
    // presence of people who read something else.
    //
    // A tombstoned page keeps its readers, exactly the way it keeps its comments
    // and reactions. Note what that does and does not promise: republishing over
    // a tombstone revives the row with new content, and the old readers come back
    // with it. That is the same trade the thread already makes, and comments at
    // least carry a hash so they render as "written against an earlier version";
    // a read carries nothing, so on a revived address it means only "someone
    // opened something that lived here".
    db.prepare("DELETE FROM page_reads WHERE mind = ? AND file = ?").run(mind, file);
  }
  // A page that is gone cites and links nobody, whether it left a tombstone or not.
  db.prepare("DELETE FROM page_citations WHERE mind = ? AND file = ?").run(mind, file);
  db.prepare("DELETE FROM page_links WHERE mind = ? AND file = ?").run(mind, file);
}

type ExistingRow = { file: string; hash: string | null; deleted_at: string | null };

function existingPages(db: Database, mind: string): Map<string, ExistingRow> {
  const rows = db
    .prepare("SELECT file, hash, deleted_at FROM published_pages WHERE mind = ?")
    .all(mind) as ExistingRow[];
  return new Map(rows.map((r) => [r.file, r]));
}

/**
 * Record what reading a page's content told us: its `comments:` frontmatter and
 * the minds it cites. Called inside the sync transactions, once the page's row
 * is known to exist.
 *
 * Citations are replaced wholesale per file rather than accumulated — a page that
 * stops naming someone has stopped citing them, and a stale citation would keep
 * surfacing a relationship the text no longer claims.
 */
function applyPageMeta(db: Database, mind: string, page: PageInput): void {
  if (page.commentsClosed !== undefined) {
    db.prepare("UPDATE published_pages SET comments_closed = ? WHERE mind = ? AND file = ?").run(
      page.commentsClosed ? 1 : 0,
      mind,
      page.file,
    );
  }
  if (page.links !== undefined) {
    // Replaced wholesale for the same reason citations are: a page that stops
    // linking somewhere has stopped linking there, and a stale row would keep
    // claiming a relationship the text no longer makes.
    db.prepare("DELETE FROM page_links WHERE mind = ? AND file = ?").run(mind, page.file);
    for (const target of page.links) {
      // A page linking around its own site is navigation, not a reference to
      // another mind's work.
      if (target === mind) continue;
      db.prepare("INSERT OR IGNORE INTO page_links (mind, file, target) VALUES (?, ?, ?)").run(
        mind,
        page.file,
        target,
      );
    }
  }
  if (page.mentions === undefined) return;
  db.prepare("DELETE FROM page_citations WHERE mind = ? AND file = ?").run(mind, page.file);
  for (const mentioned of page.mentions) {
    // A page citing its own author is not a citation, it is a signature.
    if (mentioned === mind) continue;
    db.prepare("INSERT OR IGNORE INTO page_citations (mind, file, mentioned) VALUES (?, ?, ?)").run(
      mind,
      page.file,
      mentioned,
    );
  }
}

/** Whether a page has closed comments via `comments: false` frontmatter. */
export function areCommentsClosed(db: Database, mind: string, file: string): boolean {
  const row = db
    .prepare("SELECT comments_closed FROM published_pages WHERE mind = ? AND file = ?")
    .get(mind, file) as { comments_closed: number | null } | undefined;
  return !!row?.comments_closed;
}

export type Citation = { mind: string; file: string; created_at: string };

/** Pages that name `mentioned` by @name in their body. Newest first. */
export function citationsOf(db: Database, mentioned: string): Citation[] {
  return db
    .prepare(
      `SELECT c.mind, c.file, c.created_at FROM page_citations c
       JOIN published_pages p ON p.mind = c.mind AND p.file = c.file
       WHERE c.mentioned = ? AND p.deleted_at IS NULL
       ORDER BY c.created_at DESC, c.id DESC`,
    )
    .all(mentioned) as Citation[];
}

export function syncSystemPages(db: Database, pages: PageInput[], author?: string): void {
  const existing = existingPages(db, "_system");
  const newSet = new Set(pages.map((p) => p.file));
  const threaded = pagesWithThreads(db, "_system");

  db.exec("BEGIN");
  try {
    for (const page of pages) {
      const { file, hash } = page;
      const prior = existing.get(file);
      if (!prior) {
        db.prepare(
          "INSERT INTO published_pages (mind, file, hash, author) VALUES ('_system', ?, ?, ?)",
        ).run(file, hash, author ?? null);
      } else if (prior.deleted_at != null) {
        // Republished over a tombstone: revive the identity so the surviving
        // thread reattaches to the page rather than to a permanent gravestone.
        db.prepare(
          `UPDATE published_pages
           SET deleted_at = NULL, updated_at = datetime('now'), hash = ?,
               author = COALESCE(?, author)
           WHERE mind = '_system' AND file = ?`,
        ).run(hash, author ?? null, file);
      } else if (prior.hash !== hash) {
        // Only touch files whose content actually changed — unchanged files
        // keep their updated_at and author (the publisher didn't author them).
        if (author) {
          db.prepare(
            "UPDATE published_pages SET updated_at = datetime('now'), hash = ?, author = ? WHERE mind = '_system' AND file = ?",
          ).run(hash, author, file);
        } else {
          db.prepare(
            "UPDATE published_pages SET updated_at = datetime('now'), hash = ? WHERE mind = '_system' AND file = ?",
          ).run(hash, file);
        }
      }
      applyPageMeta(db, "_system", page);
    }
    for (const [file, prior] of existing) {
      if (!newSet.has(file) && prior.deleted_at == null) {
        retirePage(db, "_system", file, threaded.has(file));
      }
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function syncPublishedPages(
  db: Database,
  mind: string,
  pages: PageInput[],
): { added: string[]; removed: string[]; updated: string[] } {
  const existing = existingPages(db, mind);
  const newSet = new Set(pages.map((p) => p.file));
  const threaded = pagesWithThreads(db, mind);
  const added: string[] = [];
  const updated: string[] = [];
  const removed: string[] = [];

  db.exec("BEGIN");
  try {
    for (const page of pages) {
      const { file, hash } = page;
      const prior = existing.get(file);
      if (!prior) {
        db.prepare("INSERT INTO published_pages (mind, file, hash) VALUES (?, ?, ?)").run(
          mind,
          file,
          hash,
        );
        added.push(file);
      } else if (prior.deleted_at != null) {
        db.prepare(
          `UPDATE published_pages SET deleted_at = NULL, updated_at = datetime('now'), hash = ?
           WHERE mind = ? AND file = ?`,
        ).run(hash, mind, file);
        added.push(file);
      } else if (prior.hash !== hash) {
        // Only bump updated_at when the content actually changed
        db.prepare(
          "UPDATE published_pages SET updated_at = datetime('now'), hash = ? WHERE mind = ? AND file = ?",
        ).run(hash, mind, file);
        updated.push(file);
      }
      applyPageMeta(db, mind, page);
    }

    for (const [file, prior] of existing) {
      if (!newSet.has(file) && prior.deleted_at == null) {
        retirePage(db, mind, file, threaded.has(file));
        removed.push(file);
      }
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  return { added, removed, updated };
}

/**
 * Insert or revive a page row directly, preserving supplied timestamps. Used by the
 * notes migration: a page's creation time is evidence of when the mind actually
 * wrote it, and must survive the move rather than being reset to migration day.
 */
export function upsertPageWithTimestamps(
  db: Database,
  mind: string,
  file: string,
  hash: string,
  publishedAt: string,
  updatedAt: string,
  author?: string | null,
): void {
  const prior = db
    .prepare("SELECT id FROM published_pages WHERE mind = ? AND file = ?")
    .get(mind, file) as { id: number } | undefined;
  if (prior) {
    db.prepare(
      `UPDATE published_pages
       SET hash = ?, published_at = ?, updated_at = ?, author = ?, deleted_at = NULL
       WHERE id = ?`,
    ).run(hash, publishedAt, updatedAt, author ?? null, prior.id);
    return;
  }
  db.prepare(
    `INSERT INTO published_pages (mind, file, hash, published_at, updated_at, author)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(mind, file, hash, publishedAt, updatedAt, author ?? null);
}
