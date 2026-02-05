import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { spawn } from "child_process";
import { existsSync } from "fs";
import { resolve } from "path";
import { findAgent, agentDir } from "../../lib/registry.js";

const app = new Hono();

app.get("/:name/logs", async (c) => {
  const name = c.req.param("name");
  const entry = findAgent(name);
  if (!entry) return c.json({ error: "Agent not found" }, 404);

  const dir = agentDir(name);
  const logFile = resolve(dir, ".molt", "logs", "supervisor.log");

  if (!existsSync(logFile)) {
    return c.json({ error: "No log file found" }, 404);
  }

  return streamSSE(c, async (stream) => {
    const tail = spawn("tail", ["-n", "200", "-f", logFile]);

    const onData = (data: Buffer) => {
      const lines = data.toString().split("\n");
      for (const line of lines) {
        if (line) {
          stream.writeSSE({ data: line }).catch(() => {});
        }
      }
    };

    tail.stdout.on("data", onData);

    // Clean up when client disconnects
    stream.onAbort(() => {
      tail.kill();
    });

    // Keep stream alive until aborted
    await new Promise<void>((resolve) => {
      tail.on("exit", resolve);
      stream.onAbort(resolve);
    });
  });
});

export default app;
