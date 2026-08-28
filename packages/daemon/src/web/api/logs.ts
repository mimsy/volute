import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { findMind, stateDir } from "../../lib/mind/registry.js";
import { boundedIntParam, intParamError } from "../../lib/util/query-params.js";
import { type AuthEnv, requireSelf } from "../middleware/auth.js";

const TAIL_LINES = { fallback: 50, min: 1, max: 10000 };

const app = new Hono<AuthEnv>()
  .get("/:name/logs", requireSelf(), async (c) => {
    const name = c.req.param("name");
    const entry = await findMind(name);
    if (!entry) return c.json({ error: "Mind not found" }, 404);

    const logFile = resolve(stateDir(name), "logs", "mind.log");

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
  .get("/:name/logs/tail", requireSelf(), async (c) => {
    const name = c.req.param("name");
    const entry = await findMind(name);
    if (!entry) return c.json({ error: "Mind not found" }, 404);

    const logFile = resolve(stateDir(name), "logs", "mind.log");
    if (!existsSync(logFile)) {
      return c.json({ error: "No log file found" }, 404);
    }

    const n = boundedIntParam(c.req.query("n"), TAIL_LINES);
    if (n === null) return c.json({ error: intParamError("n", TAIL_LINES) }, 400);
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
