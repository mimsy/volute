import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { findAgent } from "../../lib/registry.js";
import { readNdjson } from "../../lib/ndjson.js";
import {
  createConversation,
  getConversation,
  addMessage,
} from "../../lib/conversations.js";
import type { AuthEnv } from "../middleware/auth.js";
import type { MoltEvent } from "../../types.js";

const app = new Hono<AuthEnv>();

app.post("/:name/chat", async (c) => {
  const name = c.req.param("name");
  const entry = findAgent(name);
  if (!entry) return c.json({ error: "Agent not found" }, 404);

  const body = await c.req.json<{ message: string; conversationId?: string }>();
  if (!body.message) return c.json({ error: "message required" }, 400);

  const user = c.get("user");

  // Resolve or create conversation
  let conversationId = body.conversationId;
  if (conversationId) {
    const conv = getConversation(conversationId);
    if (!conv) return c.json({ error: "Conversation not found" }, 404);
  } else {
    const conv = createConversation(name, "web", {
      userId: user.id,
      title: body.message.slice(0, 80),
    });
    conversationId = conv.id;
  }

  // Save user message
  addMessage(conversationId, "user", user.username, body.message);

  const res = await fetch(`http://localhost:${entry.port}/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content: [{ type: "text", text: body.message }],
      channel: "web",
      sender: user.username,
    }),
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
    // Send conversation ID as first event
    await stream.writeSSE({
      data: JSON.stringify({ type: "meta", conversationId }),
    });

    let assistantText = "";

    for await (const event of readNdjson(res.body!)) {
      const moltEvent = event as MoltEvent;
      await stream.writeSSE({ data: JSON.stringify(moltEvent) });

      if (moltEvent.type === "text") {
        assistantText += moltEvent.content;
      }

      if (moltEvent.type === "done") {
        // Save assistant message
        if (assistantText) {
          addMessage(conversationId!, "assistant", name, assistantText);
        }
        break;
      }
    }
  });
});

export default app;
