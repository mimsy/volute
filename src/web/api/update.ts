import { spawn } from "node:child_process";
import { resolveVoluteBin } from "@volute/shared/exec";
import { checkForUpdate } from "@volute/shared/update-check";
import { Hono } from "hono";
import log from "../../lib/logger.js";
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
