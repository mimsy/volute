import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import {
  getAllDiscoveredExtensions,
  getAllDiscoveredExtensionsDetailed,
  getLoadedExtensions,
  installNpmExtension,
  setExtensionEnabled,
  uninstallNpmExtension,
} from "../../lib/extensions.js";
import { type AuthEnv, requireAdmin } from "../middleware/auth.js";

const app = new Hono<AuthEnv>()
  // Existing: returns loaded (active) extensions for sidebar/feed
  .get("/", (c) => {
    return c.json(getLoadedExtensions());
  })

  // All discovered extensions with source/enabled metadata
  .get("/all", (c) => {
    const detail = c.req.query("detail") === "true";
    return c.json(detail ? getAllDiscoveredExtensionsDetailed() : getAllDiscoveredExtensions());
  })

  // Toggle enable/disable
  .put(
    "/:id/enabled",
    requireAdmin,
    zValidator("json", z.object({ enabled: z.boolean() })),
    async (c) => {
      const { id } = c.req.param();
      const { enabled } = c.req.valid("json");
      try {
        setExtensionEnabled(id, enabled);
      } catch (err) {
        return c.json({ error: (err as Error).message }, 404);
      }
      return c.json({ ok: true, requiresRestart: true });
    },
  )

  // Install npm extension
  .post(
    "/install",
    requireAdmin,
    zValidator("json", z.object({ package: z.string() })),
    async (c) => {
      const pkg = c.req.valid("json").package.trim();
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
    },
  )

  // Uninstall npm extension
  .delete("/uninstall/:package", requireAdmin, async (c) => {
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
