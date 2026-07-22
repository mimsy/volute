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

    -- Social layer, keyed on page identity (mind, file) rather than a row id, so a
    -- thread survives the page being rewritten, republished, or deleted.
    -- page_hash records the published_pages.hash the comment was written against; a
    -- mismatch with the page's current hash is exactly what "this comment refers to
    -- an older version" means. No content snapshotting, no separate versioning.
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
  for (const column of ["author TEXT", "hash TEXT", "deleted_at TEXT"]) {
    try {
      db.exec(`ALTER TABLE published_pages ADD COLUMN ${column}`);
    } catch (err) {
      if (!(err instanceof Error) || !err.message.includes("duplicate column")) {
        throw err;
      }
    }
  }
}

/** A page file paired with a hash of its content. */
export type PageInput = { file: string; hash: string };

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
  }
}

type ExistingRow = { file: string; hash: string | null; deleted_at: string | null };

function existingPages(db: Database, mind: string): Map<string, ExistingRow> {
  const rows = db
    .prepare("SELECT file, hash, deleted_at FROM published_pages WHERE mind = ?")
    .all(mind) as ExistingRow[];
  return new Map(rows.map((r) => [r.file, r]));
}

export function syncSystemPages(db: Database, pages: PageInput[], author?: string): void {
  const existing = existingPages(db, "_system");
  const newSet = new Set(pages.map((p) => p.file));
  const threaded = pagesWithThreads(db, "_system");

  db.exec("BEGIN");
  try {
    for (const { file, hash } of pages) {
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
    for (const { file, hash } of pages) {
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
