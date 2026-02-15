import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { findAgent, stateDir } from "../../lib/registry.js";

const app = new Hono()
  .get("/:name/logs", async (c) => {
    const name = c.req.param("name");
    const entry = findAgent(name);
    if (!entry) return c.json({ error: "Agent not found" }, 404);

    const logFile = resolve(stateDir(name), "logs", "agent.log");

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
  })
  .get("/:name/logs/tail", async (c) => {
    const name = c.req.param("name");
    const entry = findAgent(name);
    if (!entry) return c.json({ error: "Agent not found" }, 404);

    const logFile = resolve(stateDir(name), "logs", "agent.log");
    if (!existsSync(logFile)) {
      return c.json({ error: "No log file found" }, 404);
    }

    const nParam = parseInt(c.req.query("n") ?? "50", 10);
    const n = Number.isFinite(nParam) && nParam > 0 ? Math.min(nParam, 10000) : 50;
    const tail = spawn("tail", ["-n", String(n), logFile]);

    let output = "";
    tail.stdout.on("data", (data: Buffer) => {
      output += data.toString();
    });

    await new Promise<void>((resolve) => {
      tail.on("exit", resolve);
    });

    return c.text(output);
  });

export default app;
