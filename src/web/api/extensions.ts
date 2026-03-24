import { Hono } from "hono";
import {
  getAllDiscoveredExtensions,
  getLoadedExtensions,
  installNpmExtension,
  setExtensionEnabled,
  uninstallNpmExtension,
} from "../../lib/extensions.js";
import type { AuthEnv } from "../middleware/auth.js";

const app = new Hono<AuthEnv>()
  // Existing: returns loaded (active) extensions for sidebar/feed
  .get("/", (c) => {
    return c.json(getLoadedExtensions());
  })

  // All discovered extensions with source/enabled metadata
  .get("/all", (c) => {
    return c.json(getAllDiscoveredExtensions());
  })

  // Toggle enable/disable
  .put("/:id/enabled", async (c) => {
    const { id } = c.req.param();
    const body = await c.req.json<{ enabled: boolean }>();
    if (typeof body.enabled !== "boolean") {
      return c.json({ error: "enabled must be a boolean" }, 400);
    }
    try {
      setExtensionEnabled(id, body.enabled);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 404);
    }
    return c.json({ ok: true, requiresRestart: true });
  })

  // Install npm extension
  .post("/install", async (c) => {
    const body = await c.req.json<{ package: string }>();
    const pkg = body.package?.trim();
    if (!pkg) {
      return c.json({ error: "package is required" }, 400);
    }
    try {
      await installNpmExtension(pkg);
      return c.json({ ok: true, requiresRestart: true });
    } catch (err) {
      const message = (err as Error).message;
      const isValidation =
        message.includes("already installed") || message.includes("Invalid package");
      return c.json({ error: message }, isValidation ? 400 : 500);
    }
  })

  // Uninstall npm extension
  .delete("/uninstall/:package", async (c) => {
    const pkg = c.req.param("package");
    try {
      await uninstallNpmExtension(pkg);
      return c.json({ ok: true, requiresRestart: true });
    } catch (err) {
      const message = (err as Error).message;
      const isValidation = message.includes("not installed");
      return c.json({ error: message }, isValidation ? 400 : 500);
    }
  });

export default app;
