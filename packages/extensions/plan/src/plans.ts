import type { Database, ExtensionContext } from "@volute/extensions";

export type Plan = {
  id: number;
  title: string;
  description: string;
  status: string;
  set_by: number;
  set_by_username: string;
  set_by_display_name: string | null;
  created_at: string;
  completed_at: string | null;
};

export type PlanLog = {
  id: number;
  plan_id: number;
  mind_name: string;
  content: string;
  created_at: string;
};

export type PlanWithLogs = Plan & {
  logs: PlanLog[];
};

type UserLookup = ExtensionContext["getUser"];

export async function setActivePlan(
  db: Database,
  getUser: UserLookup,
  userId: number,
  title: string,
  description: string,
): Promise<Plan> {
  // Archive current active plan
  db.prepare(
    "UPDATE plans SET status = 'archived', completed_at = datetime('now') WHERE status = 'active'",
  ).run();

  const row = db
    .prepare(
      `INSERT INTO plans (title, description, set_by)
       VALUES (?, ?, ?)
       RETURNING *`,
    )
    .get(title, description, userId) as {
    id: number;
    title: string;
    description: string;
    status: string;
    set_by: number;
    created_at: string;
    completed_at: string | null;
  };

  const user = await getUser(userId);
  return {
    ...row,
    set_by_username: user?.username ?? "unknown",
    set_by_display_name: user?.display_name ?? null,
  };
}

export async function getActivePlan(
  db: Database,
  getUser: UserLookup,
): Promise<PlanWithLogs | null> {
  const row = db.prepare("SELECT * FROM plans WHERE status = 'active' LIMIT 1").get() as
    | {
        id: number;
        title: string;
        description: string;
        status: string;
        set_by: number;
        created_at: string;
        completed_at: string | null;
      }
    | undefined;

  if (!row) return null;

  const user = await getUser(row.set_by);
  const logs = db
    .prepare("SELECT * FROM plan_logs WHERE plan_id = ? ORDER BY created_at DESC LIMIT 20")
    .all(row.id) as PlanLog[];

  return {
    ...row,
    set_by_username: user?.username ?? "unknown",
    set_by_display_name: user?.display_name ?? null,
    logs,
  };
}

export function logProgress(
  db: Database,
  planId: number,
  mindName: string,
  content: string,
): PlanLog {
  return db
    .prepare(
      `INSERT INTO plan_logs (plan_id, mind_name, content)
       VALUES (?, ?, ?)
       RETURNING *`,
    )
    .get(planId, mindName, content) as PlanLog;
}

export function completePlan(db: Database, planId: number): boolean {
  const result = db
    .prepare("UPDATE plans SET status = 'completed', completed_at = datetime('now') WHERE id = ?")
    .run(planId);
  return result.changes > 0;
}

export async function listPlans(
  db: Database,
  getUser: UserLookup,
  opts?: { status?: string; limit?: number; offset?: number },
): Promise<Plan[]> {
  const limit = opts?.limit ?? 20;
  const offset = opts?.offset ?? 0;

  const rows = opts?.status
    ? (db
        .prepare("SELECT * FROM plans WHERE status = ? ORDER BY created_at DESC LIMIT ? OFFSET ?")
        .all(opts.status, limit, offset) as any[])
    : (db
        .prepare("SELECT * FROM plans ORDER BY created_at DESC LIMIT ? OFFSET ?")
        .all(limit, offset) as any[]);

  const userCache = new Map<number, { username: string; display_name: string | null }>();
  const result: Plan[] = [];

  for (const row of rows) {
    if (!userCache.has(row.set_by)) {
      const u = await getUser(row.set_by);
      userCache.set(row.set_by, {
        username: u?.username ?? "unknown",
        display_name: u?.display_name ?? null,
      });
    }
    const userInfo = userCache.get(row.set_by)!;
    result.push({
      ...row,
      set_by_username: userInfo.username,
      set_by_display_name: userInfo.display_name,
    });
  }

  return result;
}
