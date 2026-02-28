import { zValidator } from "@hono/zod-validator";
import { findMind, mindDir } from "@volute/shared/registry";
import { Hono } from "hono";
import { z } from "zod";
import {
  installSkill,
  listMindSkills,
  publishSkill,
  uninstallSkill,
  updateSkill,
} from "../../lib/skills.js";
import { type AuthEnv, requireAdmin } from "../middleware/auth.js";

const app = new Hono<AuthEnv>()
  .get("/:name/skills", async (c) => {
    const name = c.req.param("name");
    const entry = findMind(name);
    if (!entry) return c.json({ error: "Mind not found" }, 404);

    const dir = mindDir(name);
    const skills = await listMindSkills(dir);
    return c.json(skills);
  })
  .post(
    "/:name/skills/install",
    requireAdmin,
    zValidator("json", z.object({ skillId: z.string() })),
    async (c) => {
      const name = c.req.param("name");
      const entry = findMind(name);
      if (!entry) return c.json({ error: "Mind not found" }, 404);

      const { skillId } = c.req.valid("json");
      const dir = mindDir(name);

      try {
        await installSkill(name, dir, skillId);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return c.json({ error: msg }, 400);
      }

      return c.json({ ok: true });
    },
  )
  .post(
    "/:name/skills/update",
    requireAdmin,
    zValidator("json", z.object({ skillId: z.string() })),
    async (c) => {
      const name = c.req.param("name");
      const entry = findMind(name);
      if (!entry) return c.json({ error: "Mind not found" }, 404);

      const { skillId } = c.req.valid("json");
      const dir = mindDir(name);

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
    requireAdmin,
    zValidator("json", z.object({ skillId: z.string() })),
    async (c) => {
      const name = c.req.param("name");
      const entry = findMind(name);
      if (!entry) return c.json({ error: "Mind not found" }, 404);

      const { skillId } = c.req.valid("json");
      const dir = mindDir(name);

      try {
        const skill = await publishSkill(name, dir, skillId);
        return c.json(skill);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return c.json({ error: msg }, 400);
      }
    },
  )
  .delete("/:name/skills/:skill", requireAdmin, async (c) => {
    const name = c.req.param("name");
    const skillName = c.req.param("skill");
    const entry = findMind(name);
    if (!entry) return c.json({ error: "Mind not found" }, 404);

    const dir = mindDir(name);

    try {
      await uninstallSkill(name, dir, skillName);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return c.json({ error: msg }, 400);
    }

    return c.json({ ok: true });
  });

export default app;
