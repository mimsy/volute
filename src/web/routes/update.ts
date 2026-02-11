import { spawn } from "node:child_process";
import { Hono } from "hono";
import { resolveVoluteBin } from "../../lib/exec.js";
import log from "../../lib/logger.js";
import { checkForUpdate } from "../../lib/update-check.js";
import { type AuthEnv, requireAdmin } from "../middleware/auth.js";

let bin: string | undefined;

const app = new Hono<AuthEnv>()
  .get("/update", async (c) => {
    const result = await checkForUpdate();
    return c.json(result);
  })
  .post("/update", requireAdmin, async (c) => {
    bin ??= resolveVoluteBin();
    const child = spawn(bin, ["update"], {
      stdio: "ignore",
      detached: true,
    });
    child.on("error", (err) => {
      log.error("Update process error", { error: err.message });
    });
    child.unref();
    return c.json({ ok: true, message: "Updating..." });
  });

export default app;
