import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { findMind, mindDir } from "../../lib/mind/registry.js";
import {
  installSkill,
  listMindSkills,
  publishSkill,
  uninstallSkill,
  updateSkill,
} from "../../lib/skills.js";
import { type AuthEnv, requireSelf } from "../middleware/auth.js";

const app = new Hono<AuthEnv>()
  .get("/:name/skills", async (c) => {
    const name = c.req.param("name");
    const entry = await findMind(name);
    if (!entry) return c.json({ error: "Mind not found" }, 404);

    const dir = entry.dir ?? mindDir(name);
    const skills = await listMindSkills(dir);
    return c.json(skills);
  })
  .post(
    "/:name/skills/install",
    requireSelf(),
    zValidator("json", z.object({ skillId: z.string() })),
    async (c) => {
      const name = c.req.param("name");
      const entry = await findMind(name);
      if (!entry) return c.json({ error: "Mind not found" }, 404);

      const { skillId } = c.req.valid("json");
      const dir = entry.dir ?? mindDir(name);

      try {
        const result = await installSkill(name, dir, skillId);
        return c.json({ ok: true, ...result });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return c.json({ error: msg }, 400);
      }
    },
  )
  .post(
    "/:name/skills/update",
    requireSelf(),
    zValidator("json", z.object({ skillId: z.string() })),
    async (c) => {
      const name = c.req.param("name");
      const entry = await findMind(name);
      if (!entry) return c.json({ error: "Mind not found" }, 404);

      const { skillId } = c.req.valid("json");
      const dir = entry.dir ?? mindDir(name);

      try {
        const result = await updateSkill(name, dir, skillId);
        return c.json(result);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return c.json({ error: msg }, 400);
      }
    },
  )
  .post(
    "/:name/skills/publish",
    requireSelf(),
    zValidator("json", z.object({ skillId: z.string() })),
    async (c) => {
      const name = c.req.param("name");
      const entry = await findMind(name);
      if (!entry) return c.json({ error: "Mind not found" }, 404);

      const { skillId } = c.req.valid("json");
      const dir = entry.dir ?? mindDir(name);

      try {
        const skill = await publishSkill(name, dir, skillId);
        return c.json(skill);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return c.json({ error: msg }, 400);
      }
    },
  )
  .delete("/:name/skills/:skill", requireSelf(), async (c) => {
    const name = c.req.param("name");
    const skillName = c.req.param("skill");
    const entry = await findMind(name);
    if (!entry) return c.json({ error: "Mind not found" }, 404);

    const dir = entry.dir ?? mindDir(name);

    try {
      await uninstallSkill(name, dir, skillName);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return c.json({ error: msg }, 400);
    }

    return c.json({ ok: true });
  });

export default app;
