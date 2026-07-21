import type { Database } from "@volute/extensions";

export function initDb(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS intentions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mind_name TEXT NOT NULL,
      content TEXT NOT NULL,
      note TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      review_at TEXT NOT NULL,
      last_surfaced_at TEXT,
      resolved_at TEXT,
      resolution_note TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_intentions_mind ON intentions(mind_name);
    CREATE INDEX IF NOT EXISTS idx_intentions_status ON intentions(status);
    CREATE INDEX IF NOT EXISTS idx_intentions_review ON intentions(review_at);

    -- Small key/value store for one-time bootstrap markers (see spirit-schedule.ts).
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}
