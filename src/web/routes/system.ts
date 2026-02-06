import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { logBuffer } from "../../lib/log-buffer.js";
import type { AuthEnv } from "../middleware/auth.js";

const app = new Hono<AuthEnv>().get("/logs", async (c) => {
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
});

export default app;
