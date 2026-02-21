import { zValidator } from "@hono/zod-validator";
import { eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { getDb } from "../../lib/db.js";
import { PROMPT_DEFAULTS, PROMPT_KEYS, type PromptKey } from "../../lib/prompts.js";
import { systemPrompts } from "../../lib/schema.js";
import { type AuthEnv, requireAdmin } from "../middleware/auth.js";

const app = new Hono<AuthEnv>()
  .get("/", async (c) => {
    let rows: { key: string; content: string }[];
    try {
      const db = await getDb();
      rows = await db.select().from(systemPrompts).all();
    } catch (err) {
      console.error("[prompts] failed to query system_prompts:", err);
      return c.json({ error: "Failed to load prompts from database" }, 500);
    }
    const customMap = new Map(rows.map((r) => [r.key, r.content]));

    const prompts = PROMPT_KEYS.map((key) => {
      const meta = PROMPT_DEFAULTS[key];
      const custom = customMap.get(key);
      return {
        key,
        content: custom ?? meta.content,
        description: meta.description,
        variables: meta.variables,
        isCustom: custom !== undefined,
        category: meta.category,
      };
    });

    return c.json(prompts);
  })
  .put("/:key", requireAdmin, zValidator("json", z.object({ content: z.string() })), async (c) => {
    const key = c.req.param("key");
    if (!PROMPT_KEYS.includes(key as PromptKey)) {
      return c.json({ error: "Unknown prompt key" }, 404);
    }
    const { content } = c.req.valid("json");
    const db = await getDb();
    await db
      .insert(systemPrompts)
      .values({ key, content, updated_at: sql`(datetime('now'))` })
      .onConflictDoUpdate({
        target: systemPrompts.key,
        set: { content, updated_at: sql`(datetime('now'))` },
      });
    return c.json({ ok: true });
  })
  .delete("/:key", requireAdmin, async (c) => {
    const key = c.req.param("key");
    if (!PROMPT_KEYS.includes(key as PromptKey)) {
      return c.json({ error: "Unknown prompt key" }, 404);
    }
    const db = await getDb();
    await db.delete(systemPrompts).where(eq(systemPrompts.key, key));
    return c.json({ ok: true });
  });

export default app;
