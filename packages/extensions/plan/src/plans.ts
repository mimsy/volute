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
  finish_message: string | null;
};

export type PlanLog = {
  id: number;
  plan_id: number;
  mind_name: string;
  content: string;
  created_at: string;
};

export type PlanMessage = {
  id: number;
  plan_id: number;
  content: string;
  created_at: string;
};

export type PlanWithDetails = Plan & {
  logs: PlanLog[];
  messages: PlanMessage[];
  latestMessage: string | null;
};

type UserLookup = ExtensionContext["getUser"];

export async function startPlan(
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
    finish_message: string | null;
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
): Promise<PlanWithDetails | null> {
  const row = db.prepare("SELECT * FROM plans WHERE status = 'active' LIMIT 1").get() as
    | {
        id: number;
        title: string;
        description: string;
        status: string;
        set_by: number;
        created_at: string;
        completed_at: string | null;
        finish_message: string | null;
      }
    | undefined;

  if (!row) return null;

  const user = await getUser(row.set_by);
  const logs = db
    .prepare("SELECT * FROM plan_logs WHERE plan_id = ? ORDER BY created_at DESC LIMIT 20")
    .all(row.id) as PlanLog[];
  const messages = db
    .prepare("SELECT * FROM plan_messages WHERE plan_id = ? ORDER BY id DESC LIMIT 10")
    .all(row.id) as PlanMessage[];

  const latestMessage = messages.length > 0 ? messages[0].content : null;

  return {
    ...row,
    set_by_username: user?.username ?? "unknown",
    set_by_display_name: user?.display_name ?? null,
    logs,
    messages,
    latestMessage,
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

export function addPlanMessage(db: Database, planId: number, content: string): PlanMessage {
  return db
    .prepare(
      `INSERT INTO plan_messages (plan_id, content)
       VALUES (?, ?)
       RETURNING *`,
    )
    .get(planId, content) as PlanMessage;
}

export function finishPlan(db: Database, planId: number, message?: string): boolean {
  const result = db
    .prepare(
      "UPDATE plans SET status = 'completed', completed_at = datetime('now'), finish_message = ? WHERE id = ?",
    )
    .run(message ?? null, planId);
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
