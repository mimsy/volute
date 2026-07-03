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
  `);
  // Migrations: add columns if missing
  for (const column of ["author TEXT", "hash TEXT"]) {
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
type SiteEntry = {
  mind: string;
  files: { file: string; updated_at: string; author: string | null }[];
};

export function getPublishedPages(db: Database, mind: string): PublishedPage[] {
  return db
    .prepare(
      "SELECT file, published_at, updated_at, author FROM published_pages WHERE mind = ? ORDER BY file",
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
        "SELECT mind, file, updated_at, author FROM published_pages WHERE mind = ? ORDER BY updated_at DESC LIMIT ?",
      )
      .all(opts.mind, limit) as RecentPage[];
  }
  // Include all pages (mind + system) in the global recent list
  return db
    .prepare(
      "SELECT mind, file, updated_at, author FROM published_pages ORDER BY updated_at DESC LIMIT ?",
    )
    .all(limit) as RecentPage[];
}

export function getAllSites(db: Database): SiteEntry[] {
  // Exclude _system pages — those are shown separately
  const rows = db
    .prepare(
      "SELECT mind, file, updated_at, author FROM published_pages WHERE mind != '_system' ORDER BY mind, file",
    )
    .all() as RecentPage[];

  const siteMap = new Map<string, { file: string; updated_at: string; author: string | null }[]>();
  for (const row of rows) {
    let files = siteMap.get(row.mind);
    if (!files) {
      files = [];
      siteMap.set(row.mind, files);
    }
    files.push({ file: row.file, updated_at: row.updated_at, author: row.author });
  }

  return Array.from(siteMap.entries()).map(([mind, files]) => ({ mind, files }));
}

export function getSystemPages(db: Database): SiteEntry | null {
  const rows = db
    .prepare(
      "SELECT mind, file, updated_at, author FROM published_pages WHERE mind = '_system' ORDER BY file",
    )
    .all() as RecentPage[];
  if (rows.length === 0) return null;
  return {
    mind: "_system",
    files: rows.map((r) => ({ file: r.file, updated_at: r.updated_at, author: r.author })),
  };
}

export function syncSystemPages(db: Database, pages: PageInput[], author?: string): void {
  const existing = new Map(
    (
      db.prepare("SELECT file, hash FROM published_pages WHERE mind = '_system'").all() as {
        file: string;
        hash: string | null;
      }[]
    ).map((r) => [r.file, r.hash]),
  );
  const newSet = new Set(pages.map((p) => p.file));

  db.exec("BEGIN");
  try {
    for (const { file, hash } of pages) {
      if (!existing.has(file)) {
        db.prepare(
          "INSERT INTO published_pages (mind, file, hash, author) VALUES ('_system', ?, ?, ?)",
        ).run(file, hash, author ?? null);
      } else if (existing.get(file) !== hash) {
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
    for (const file of existing.keys()) {
      if (!newSet.has(file)) {
        db.prepare("DELETE FROM published_pages WHERE mind = '_system' AND file = ?").run(file);
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
  const existing = new Map(
    (
      db.prepare("SELECT file, hash FROM published_pages WHERE mind = ?").all(mind) as {
        file: string;
        hash: string | null;
      }[]
    ).map((r) => [r.file, r.hash]),
  );

  const newSet = new Set(pages.map((p) => p.file));
  const added: string[] = [];
  const updated: string[] = [];
  const removed: string[] = [];

  db.exec("BEGIN");
  try {
    for (const { file, hash } of pages) {
      if (!existing.has(file)) {
        db.prepare("INSERT INTO published_pages (mind, file, hash) VALUES (?, ?, ?)").run(
          mind,
          file,
          hash,
        );
        added.push(file);
      } else if (existing.get(file) !== hash) {
        // Only bump updated_at when the content actually changed
        db.prepare(
          "UPDATE published_pages SET updated_at = datetime('now'), hash = ? WHERE mind = ? AND file = ?",
        ).run(hash, mind, file);
        updated.push(file);
      }
    }

    for (const file of existing.keys()) {
      if (!newSet.has(file)) {
        db.prepare("DELETE FROM published_pages WHERE mind = ? AND file = ?").run(mind, file);
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
