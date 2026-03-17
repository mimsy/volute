import { Hono } from "hono";
import { getChannelDriver } from "../../lib/channels.js";
import { loadMergedEnv } from "../../lib/env.js";
import { findMind, mindDir } from "../../lib/registry.js";
import { type AuthEnv, requireSelf } from "../middleware/auth.js";

function buildEnv(name: string): Record<string, string> {
  return { ...loadMergedEnv(name), VOLUTE_MIND: name, VOLUTE_MIND_DIR: mindDir(name) };
}

const app = new Hono<AuthEnv>().post("/:name/channels/create", requireSelf(), async (c) => {
  const name = c.req.param("name");
  if (!(await findMind(name))) return c.json({ error: "Mind not found" }, 404);

  const {
    platform,
    participants,
    name: convName,
    sender,
  } = await c.req.json<{
    platform: string;
    participants: string[];
    name?: string;
    sender?: string;
  }>();

  const driver = getChannelDriver(platform);
  if (!driver?.createConversation) {
    return c.json({ error: `Platform ${platform} does not support creating conversations` }, 400);
  }

  const env = buildEnv(name);
  if (sender) env.VOLUTE_SENDER = sender;
  try {
    const slug = await driver.createConversation(env, participants, convName);
    // For volute, the slug is the bare conversationId — return both for callers that need the ID
    return c.json({ slug, conversationId: slug });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

export default app;
