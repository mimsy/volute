import type { Database } from "@volute/extensions";

export type Feedback = {
  id: number;
  mind_name: string;
  about: string;
  content: string;
  status: "pending" | "filed" | "dismissed";
  created_at: string;
  resolved_at: string | null;
  issue_url: string | null;
  resolution_note: string | null;
};

export const MAX_CONTENT_LENGTH = 4000;
/** A mind can't flood the spirit's queue: past this many unreviewed reports, it waits. */
export const MAX_PENDING_PER_MIND = 10;
/** Feedback about Volute itself, and where it files unless a host points it elsewhere. */
export const CORE_AREA = "volute";
export const CORE_REPO = "mimsy/volute";

const AREA = /^[a-z0-9][a-z0-9-]*$/;
const REPO = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/;
export const isArea = (s: string) => AREA.test(s);
export const isRepo = (s: string) => REPO.test(s);

export function addFeedback(db: Database, mind: string, about: string, content: string): Feedback {
  const { lastInsertRowid } = db
    .prepare("INSERT INTO feedback (mind_name, about, content) VALUES (?, ?, ?)")
    .run(mind, about, content);
  return getFeedback(db, Number(lastInsertRowid)) as Feedback;
}

export function getFeedback(db: Database, id: number): Feedback | null {
  return (db.prepare("SELECT * FROM feedback WHERE id = ?").get(id) as Feedback) ?? null;
}

export function countPending(db: Database, mind: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM feedback WHERE mind_name = ? AND status = 'pending'")
    .get(mind) as { n: number };
  return row.n;
}

export function listMine(db: Database, mind: string): Feedback[] {
  return db
    .prepare("SELECT * FROM feedback WHERE mind_name = ? ORDER BY id DESC LIMIT 20")
    .all(mind) as Feedback[];
}

export function listPending(db: Database): Feedback[] {
  return db
    .prepare("SELECT * FROM feedback WHERE status = 'pending' ORDER BY id")
    .all() as Feedback[];
}

export function resolveFeedback(
  db: Database,
  id: number,
  status: "filed" | "dismissed",
  fields: { issueUrl?: string; note?: string },
): void {
  db.prepare(
    "UPDATE feedback SET status = ?, resolved_at = datetime('now'), issue_url = ?, resolution_note = ? WHERE id = ?",
  ).run(status, fields.issueUrl ?? null, fields.note ?? null, id);
}

function getMeta(db: Database, key: string): string | null {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

function setMeta(db: Database, key: string, value: string): void {
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(key, value);
}

export const getToken = (db: Database) => getMeta(db, "github_token");
export const setToken = (db: Database, token: string) => setMeta(db, "github_token", token);
export const setRepo = (db: Database, area: string, repo: string) =>
  setMeta(db, `repo:${area}`, repo);

/** Every area that has somewhere to file, the core one first. */
export function listRepos(db: Database): { area: string; repo: string }[] {
  const rows = db
    .prepare("SELECT key, value FROM meta WHERE key LIKE 'repo:%' ORDER BY key")
    .all() as { key: string; value: string }[];
  const set = rows.map((r) => ({ area: r.key.slice("repo:".length), repo: r.value }));
  const core = set.find((r) => r.area === CORE_AREA) ?? { area: CORE_AREA, repo: CORE_REPO };
  return [core, ...set.filter((r) => r.area !== CORE_AREA)];
}

export function repoFor(db: Database, area: string): string | null {
  return listRepos(db).find((r) => r.area === area)?.repo ?? null;
}
