import { spawn } from "node:child_process";
import { Hono } from "hono";
import { resolveVoluteBin } from "../../lib/exec.js";
import { checkForUpdate } from "../../lib/update-check.js";
import { type AuthEnv, requireAdmin } from "../middleware/auth.js";

const app = new Hono<AuthEnv>()
  .get("/update", async (c) => {
    const result = await checkForUpdate();
    return c.json(result);
  })
  .post("/update", requireAdmin, async (c) => {
    const bin = resolveVoluteBin();
    const child = spawn(bin, ["update"], {
      stdio: "ignore",
      detached: true,
    });
    child.unref();
    return c.json({ ok: true, message: "Updating..." });
  });

export default app;
