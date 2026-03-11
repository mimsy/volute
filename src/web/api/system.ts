import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import { logBuffer } from "../../lib/log-buffer.js";
import {
  deleteSystemsConfig,
  readSystemsConfig,
  writeSystemsConfig,
} from "../../lib/systems-config.js";
import { type AuthEnv, requireAdmin } from "../middleware/auth.js";

const DEFAULT_API_URL = "https://volute.systems";

const app = new Hono<AuthEnv>()
  .post("/restart", requireAdmin, (c) => {
    // Exit with code 1 so systemd Restart=on-failure restarts the daemon
    setTimeout(() => process.exit(1), 200);
    return c.json({ ok: true });
  })
  .post("/stop", requireAdmin, (c) => {
    // Exit with code 0 so systemd does not restart
    setTimeout(() => process.exit(0), 200);
    return c.json({ ok: true });
  })
  .get("/logs", async (c) => {
    const user = c.get("user");
    if (user.role !== "admin") return c.json({ error: "Forbidden" }, 403);

    return streamSSE(c, async (stream) => {
      // Send existing entries
      for (const entry of logBuffer.getEntries()) {
        await stream.writeSSE({ data: JSON.stringify(entry) });
      }

      // Subscribe to new entries
      const unsubscribe = logBuffer.subscribe((entry) => {
        stream.writeSSE({ data: JSON.stringify(entry) }).catch(() => {});
      });

      // Keep alive until client disconnects
      await new Promise<void>((resolve) => {
        stream.onAbort(() => {
          unsubscribe();
          resolve();
        });
      });
    });
  })
  .get("/info", (c) => {
    const config = readSystemsConfig();
    return c.json({ system: config?.system ?? null });
  })
  .post(
    "/register",
    requireAdmin,
    zValidator("json", z.object({ name: z.string().min(1) })),
    async (c) => {
      const existing = readSystemsConfig();
      if (existing) {
        return c.json({ error: `Already registered as "${existing.system}"` }, 400);
      }
      const { name } = c.req.valid("json");
      const apiUrl = process.env.VOLUTE_SYSTEMS_URL || DEFAULT_API_URL;
      let apiKey: string;
      let system: string;
      try {
        const res = await fetch(`${apiUrl}/api/register`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: name.trim() }),
        });
        if (!res.ok) {
          const err = (await res.json().catch(() => ({ error: `HTTP ${res.status}` }))) as {
            error: string;
          };
          return c.json({ error: err.error }, 502);
        }
        ({ apiKey, system } = (await res.json()) as { apiKey: string; system: string });
      } catch (err) {
        return c.json({ error: `Connection failed: ${(err as Error).message}` }, 502);
      }
      try {
        writeSystemsConfig({ apiKey, system, apiUrl });
      } catch (err) {
        return c.json(
          {
            error: `Registered as "${system}" but failed to save config: ${(err as Error).message}`,
          },
          500,
        );
      }
      return c.json({ system });
    },
  )
  .post(
    "/login",
    requireAdmin,
    zValidator("json", z.object({ key: z.string().min(1) })),
    async (c) => {
      const existing = readSystemsConfig();
      if (existing) {
        return c.json({ error: `Already logged in as "${existing.system}"` }, 400);
      }
      const { key } = c.req.valid("json");
      const apiUrl = process.env.VOLUTE_SYSTEMS_URL || DEFAULT_API_URL;
      let system: string;
      try {
        const res = await fetch(`${apiUrl}/api/whoami`, {
          headers: { Authorization: `Bearer ${key.trim()}` },
        });
        if (!res.ok) {
          const err = (await res.json().catch(() => ({ error: `HTTP ${res.status}` }))) as {
            error: string;
          };
          return c.json({ error: err.error }, 502);
        }
        ({ system } = (await res.json()) as { system: string });
      } catch (err) {
        return c.json({ error: `Connection failed: ${(err as Error).message}` }, 502);
      }
      try {
        writeSystemsConfig({ apiKey: key.trim(), system, apiUrl });
      } catch (err) {
        return c.json(
          {
            error: `Logged in as "${system}" but failed to save config: ${(err as Error).message}`,
          },
          500,
        );
      }
      return c.json({ system });
    },
  )
  .post("/logout", requireAdmin, (c) => {
    deleteSystemsConfig();
    return c.json({ ok: true });
  })
  // Proxy pages publish/status through daemon so CLI doesn't need direct file access
  .put("/pages/publish/:name", requireAdmin, async (c) => {
    const config = readSystemsConfig();
    if (!config) return c.json({ error: "Not connected to volute.systems" }, 400);
    const name = c.req.param("name");
    const body = await c.req.text();
    try {
      const res = await fetch(`${config.apiUrl}/api/pages/publish/${name}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
        },
        body,
      });
      const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      return c.json(data as Record<string, unknown>, res.status as ContentfulStatusCode);
    } catch (err) {
      return c.json({ error: `Connection failed: ${(err as Error).message}` }, 502);
    }
  })
  .get("/pages/status/:name", requireAdmin, async (c) => {
    const config = readSystemsConfig();
    if (!config) return c.json({ error: "Not connected to volute.systems" }, 400);
    const name = c.req.param("name");
    try {
      const res = await fetch(`${config.apiUrl}/api/pages/status/${name}`, {
        headers: { Authorization: `Bearer ${config.apiKey}` },
      });
      const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      return c.json(data as Record<string, unknown>, res.status as ContentfulStatusCode);
    } catch (err) {
      return c.json({ error: `Connection failed: ${(err as Error).message}` }, 502);
    }
  });

export default app;
