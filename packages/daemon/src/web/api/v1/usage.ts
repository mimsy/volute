import { Hono } from "hono";
import { getSpendBudget } from "../../../lib/daemon/spend-budget.js";
import { readWindow, usageReport } from "../../../lib/daemon/usage-report.js";
import { type AuthEnv, authMiddleware, requireAdmin } from "../../middleware/auth.js";

/**
 * The install-wide bucket, when a system cap is configured. Absent before
 * `initSpendBudget()` runs (the web server listens first), which is not an error —
 * the page just has no cap to draw.
 */
function systemBudget() {
  try {
    return getSpendBudget().getSystemUsage();
  } catch {
    return null;
  }
}

// Defense in depth: /api/v1/* is already guarded in app.ts, but re-assert here so
// this router can't be mounted unauthenticated.
const app = new Hono<AuthEnv>()
  .use("*", authMiddleware)
  // Install-wide spend across every mind. Admin-only: one mind's costs are not another
  // mind's business, and the per-mind view a mind is entitled to lives at
  // GET /api/v1/minds/:name/usage behind requireSelf().
  .get("/", requireAdmin, async (c) => {
    const window = readWindow(c.req.query("window"));
    if (!window) return c.json({ error: "Invalid window" }, 400);
    const report = await usageReport({ window });
    return c.json({ ...report, system: systemBudget() });
  });

export default app;
