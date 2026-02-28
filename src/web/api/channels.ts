import { loadMergedEnv } from "@volute/shared/env";
import { findMind, mindDir } from "@volute/shared/registry";
import { Hono } from "hono";
import { writeChannelEntry } from "../../connectors/sdk.js";
import { CHANNELS, getChannelDriver, type ImageAttachment } from "../../lib/channels.js";
import { type AuthEnv, requireAdmin } from "../middleware/auth.js";

function buildEnv(name: string): Record<string, string> {
  return { ...loadMergedEnv(name), VOLUTE_MIND: name, VOLUTE_MIND_DIR: mindDir(name) };
}

const app = new Hono<AuthEnv>()
  .post("/:name/channels/send", requireAdmin, async (c) => {
    const name = c.req.param("name");
    if (!findMind(name)) return c.json({ error: "Mind not found" }, 404);

    const { platform, uri, message, images, sender } = await c.req.json<{
      platform: string;
      uri: string;
      message: string;
      images?: ImageAttachment[];
      sender?: string;
    }>();
    const driver = getChannelDriver(platform);
    if (!driver) return c.json({ error: `No driver for platform: ${platform}` }, 400);

    const env = buildEnv(name);
    if (sender) env.VOLUTE_SENDER = sender;
    try {
      await driver.send(env, uri, message, images);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  })
  .get("/:name/channels/read", async (c) => {
    const name = c.req.param("name");
    if (!findMind(name)) return c.json({ error: "Mind not found" }, 404);

    const platform = c.req.query("platform");
    const uri = c.req.query("uri");
    const limit = parseInt(c.req.query("limit") ?? "20", 10) || 20;

    if (!platform || !uri) return c.json({ error: "platform and uri required" }, 400);

    const driver = getChannelDriver(platform);
    if (!driver) return c.json({ error: `No driver for platform: ${platform}` }, 400);

    const env = buildEnv(name);
    try {
      const output = await driver.read(env, uri, limit);
      return c.text(output);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  })
  .get("/:name/channels/list", async (c) => {
    const name = c.req.param("name");
    if (!findMind(name)) return c.json({ error: "Mind not found" }, 404);

    const platform = c.req.query("platform");
    const platforms = platform ? [platform] : Object.keys(CHANNELS);
    const env = buildEnv(name);
    const results: Record<string, unknown[]> = {};

    for (const p of platforms) {
      const driver = getChannelDriver(p);
      if (!driver?.listConversations) continue;

      try {
        const convs = await driver.listConversations(env);
        for (const conv of convs) {
          writeChannelEntry(name, conv.id, {
            platformId: conv.platformId,
            platform: p,
            name: conv.name,
            type: conv.type,
          });
        }
        results[p] = convs;
      } catch (err) {
        results[p] = [{ error: err instanceof Error ? err.message : String(err) }];
      }
    }

    return c.json(results);
  })
  .get("/:name/channels/users", async (c) => {
    const name = c.req.param("name");
    if (!findMind(name)) return c.json({ error: "Mind not found" }, 404);

    const platform = c.req.query("platform");
    if (!platform) return c.json({ error: "platform required" }, 400);

    const driver = getChannelDriver(platform);
    if (!driver?.listUsers)
      return c.json({ error: `Platform ${platform} does not support listing users` }, 400);

    const env = buildEnv(name);
    try {
      const users = await driver.listUsers(env);
      return c.json(users);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  })
  .post("/:name/channels/create", requireAdmin, async (c) => {
    const name = c.req.param("name");
    if (!findMind(name)) return c.json({ error: "Mind not found" }, 404);

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
      return c.json({ slug });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

export default app;
