import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
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
  .post("/register", requireAdmin, async (c) => {
    const existing = readSystemsConfig();
    if (existing) {
      return c.json({ error: `Already registered as "${existing.system}"` }, 400);
    }
    const body = await c.req.json<{ name: string }>();
    if (!body.name?.trim()) {
      return c.json({ error: "System name is required" }, 400);
    }
    const apiUrl = process.env.VOLUTE_SYSTEMS_URL || DEFAULT_API_URL;
    try {
      const res = await fetch(`${apiUrl}/api/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: body.name.trim() }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({ error: `HTTP ${res.status}` }))) as {
          error: string;
        };
        return c.json({ error: err.error }, res.status as 400);
      }
      const { apiKey, system } = (await res.json()) as { apiKey: string; system: string };
      writeSystemsConfig({ apiKey, system, apiUrl });
      return c.json({ system });
    } catch (err) {
      return c.json({ error: `Connection failed: ${(err as Error).message}` }, 502);
    }
  })
  .post("/login", requireAdmin, async (c) => {
    const existing = readSystemsConfig();
    if (existing) {
      return c.json({ error: `Already logged in as "${existing.system}"` }, 400);
    }
    const body = await c.req.json<{ key: string }>();
    if (!body.key?.trim()) {
      return c.json({ error: "API key is required" }, 400);
    }
    const apiUrl = process.env.VOLUTE_SYSTEMS_URL || DEFAULT_API_URL;
    try {
      const res = await fetch(`${apiUrl}/api/whoami`, {
        headers: { Authorization: `Bearer ${body.key.trim()}` },
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({ error: `HTTP ${res.status}` }))) as {
          error: string;
        };
        return c.json({ error: err.error }, res.status as 400);
      }
      const { system } = (await res.json()) as { system: string };
      writeSystemsConfig({ apiKey: body.key.trim(), system, apiUrl });
      return c.json({ system });
    } catch (err) {
      return c.json({ error: `Connection failed: ${(err as Error).message}` }, 502);
    }
  })
  .post("/logout", requireAdmin, (c) => {
    deleteSystemsConfig();
    return c.json({ ok: true });
  });

export default app;
