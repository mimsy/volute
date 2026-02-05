import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { findAgent } from "../../lib/registry.js";
import { readNdjson } from "../../lib/ndjson.js";

const app = new Hono();

app.post("/:name/chat", async (c) => {
  const name = c.req.param("name");
  const entry = findAgent(name);
  if (!entry) return c.json({ error: "Agent not found" }, 404);

  const body = await c.req.json<{ message: string }>();
  if (!body.message) return c.json({ error: "message required" }, 400);

  const res = await fetch(`http://localhost:${entry.port}/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: [{ type: "text", text: body.message }] }),
  });

  if (!res.ok) {
    return c.json(
      { error: `Agent responded with ${res.status}` },
      res.status as 500,
    );
  }

  if (!res.body) {
    return c.json({ error: "No response body from agent" }, 502);
  }

  return streamSSE(c, async (stream) => {
    for await (const event of readNdjson(res.body!)) {
      await stream.writeSSE({ data: JSON.stringify(event) });
      if (event.type === "done") break;
    }
  });
});

export default app;
