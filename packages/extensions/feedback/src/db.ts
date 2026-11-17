import type { Database } from "@volute/extensions";

export function initDb(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mind_name TEXT NOT NULL,
      about TEXT NOT NULL DEFAULT 'volute',
      content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at TEXT,
      issue_url TEXT,
      resolution_note TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_feedback_status ON feedback(status);
    CREATE INDEX IF NOT EXISTS idx_feedback_mind ON feedback(mind_name);

    -- Settings (the GitHub token, the repository each area files to) and the
    -- one-time spirit schedule marker.
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}
