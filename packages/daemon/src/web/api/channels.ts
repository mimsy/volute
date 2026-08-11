import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { loadMergedEnv } from "../../lib/config/env.js";
import { findMind, mindDir } from "../../lib/mind/registry.js";
import { getPlatformDriver } from "../../lib/platforms.js";
import { type AuthEnv, requireSelf } from "../middleware/auth.js";

function buildEnv(name: string): Record<string, string> {
  return { ...loadMergedEnv(name), VOLUTE_MIND: name, VOLUTE_MIND_DIR: mindDir(name) };
}

const createChannelSchema = z.object({
  platform: z.string(),
  participants: z.array(z.string()),
  name: z.string().optional(),
  sender: z.string().optional(),
});

const app = new Hono<AuthEnv>().post(
  "/:name/channels/create",
  requireSelf(),
  zValidator("json", createChannelSchema),
  async (c) => {
    const name = c.req.param("name");
    if (!(await findMind(name))) return c.json({ error: "Mind not found" }, 404);

    const { platform, participants, name: convName, sender } = c.req.valid("json");

    const driver = getPlatformDriver(platform);
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
  },
);

export default app;
