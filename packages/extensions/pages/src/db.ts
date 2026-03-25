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
  // Migration: add author column if missing
  try {
    db.exec("ALTER TABLE published_pages ADD COLUMN author TEXT");
  } catch (err) {
    if (!(err instanceof Error) || !err.message.includes("duplicate column")) {
      throw err;
    }
  }
}

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

export function syncSystemPages(db: Database, htmlFiles: string[], author?: string): void {
  const existing = new Set(
    (
      db.prepare("SELECT file FROM published_pages WHERE mind = '_system'").all() as {
        file: string;
      }[]
    ).map((r) => r.file),
  );
  const newSet = new Set(htmlFiles);

  db.exec("BEGIN");
  try {
    for (const file of htmlFiles) {
      if (existing.has(file)) {
        if (author) {
          db.prepare(
            "UPDATE published_pages SET updated_at = datetime('now'), author = ? WHERE mind = '_system' AND file = ?",
          ).run(author, file);
        } else {
          db.prepare(
            "UPDATE published_pages SET updated_at = datetime('now') WHERE mind = '_system' AND file = ?",
          ).run(file);
        }
      } else {
        db.prepare("INSERT INTO published_pages (mind, file, author) VALUES ('_system', ?, ?)").run(
          file,
          author ?? null,
        );
      }
    }
    for (const file of existing) {
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
  pageFiles: string[],
): { added: string[]; removed: string[]; updated: string[] } {
  const existing = new Map(
    (
      db.prepare("SELECT file, updated_at FROM published_pages WHERE mind = ?").all(mind) as {
        file: string;
        updated_at: string;
      }[]
    ).map((r) => [r.file, r.updated_at]),
  );

  const newSet = new Set(pageFiles);
  const added: string[] = [];
  const updated: string[] = [];
  const removed: string[] = [];

  db.exec("BEGIN");
  try {
    for (const file of pageFiles) {
      if (existing.has(file)) {
        db.prepare(
          "UPDATE published_pages SET updated_at = datetime('now') WHERE mind = ? AND file = ?",
        ).run(mind, file);
        updated.push(file);
      } else {
        db.prepare("INSERT INTO published_pages (mind, file) VALUES (?, ?)").run(mind, file);
        added.push(file);
      }
    }

    for (const [file] of existing) {
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
