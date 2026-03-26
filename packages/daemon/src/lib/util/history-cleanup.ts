import { and, eq, lt } from "drizzle-orm";
import { getDb } from "../db.js";
import { mindHistory } from "../schema.js";

/** Default retention for log entries: 24 hours. */
const LOG_RETENTION_MS = 24 * 60 * 60 * 1000;

/** Delete log entries from mind_history older than the retention period. */
export async function cleanExpiredLogs(): Promise<void> {
  const db = await getDb();
  const cutoff = new Date(Date.now() - LOG_RETENTION_MS)
    .toISOString()
    .replace("T", " ")
    .slice(0, 19);
  await db
    .delete(mindHistory)
    .where(and(eq(mindHistory.type, "log"), lt(mindHistory.created_at, cutoff)));
}
