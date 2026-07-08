import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { eq } from "drizzle-orm";
import {
  runMaintenance,
  startMaintenanceInterval,
} from "../packages/daemon/src/lib/daemon/maintenance.js";
import { getDb } from "../packages/daemon/src/lib/db.js";
import { mindHistory } from "../packages/daemon/src/lib/schema.js";

function ago(ms: number): string {
  return new Date(Date.now() - ms).toISOString().replace("T", " ").slice(0, 19);
}

describe("runMaintenance", () => {
  it("deletes log rows older than the retention window and keeps newer ones", async () => {
    const db = await getDb();
    const mind = `maint-test-${process.pid}`;
    const twoDays = 2 * 24 * 60 * 60 * 1000;
    const oneHour = 60 * 60 * 1000;

    await db.insert(mindHistory).values([
      { mind, type: "log", content: "old", created_at: ago(twoDays) },
      { mind, type: "log", content: "fresh", created_at: ago(oneHour) },
      // A non-log row past the window must survive — retention only touches logs.
      { mind, type: "message", content: "old message", created_at: ago(twoDays) },
    ]);

    await runMaintenance();

    const rows = await db.select().from(mindHistory).where(eq(mindHistory.mind, mind));
    const contents = rows.map((r) => r.content).sort();
    assert.deepEqual(contents, ["fresh", "old message"]);
  });
});

describe("startMaintenanceInterval", () => {
  it("runs the maintenance task on each tick and stops once cleared", (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });

    let runs = 0;
    const task = async () => {
      runs++;
    };
    const handle = startMaintenanceInterval(1000, task);

    t.mock.timers.tick(1000);
    t.mock.timers.tick(1000);
    assert.equal(runs, 2);

    // Shutdown clears the interval: no further ticks fire the task.
    clearInterval(handle);
    t.mock.timers.tick(1000);
    assert.equal(runs, 2);
  });
});
