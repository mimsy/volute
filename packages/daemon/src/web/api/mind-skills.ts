import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { chownMindDir } from "../../lib/mind/isolation.js";
import { findMind, mindDir } from "../../lib/mind/registry.js";
import {
  installSkill,
  listMindSkills,
  publishSkill,
  uninstallSkill,
  updateSkill,
} from "../../lib/skills.js";
import { type AuthEnv, requireSelf } from "../middleware/auth.js";

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * A skill operation that throws part-way may already have written files as the
 * daemon (root under user isolation), so ownership goes back to the mind on
 * failure too. If that fails as well, the error says so — root-owned files in a
 * mind's tree are the #467 class of break and must not go unreported.
 */
async function failureAfterChown(e: unknown, dir: string, name: string): Promise<string> {
  try {
    await chownMindDir(dir, name);
    return errorMessage(e);
  } catch (chownErr) {
    return `${errorMessage(e)} (restoring ownership also failed: ${errorMessage(chownErr)})`;
  }
}

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

      let result: Awaited<ReturnType<typeof installSkill>>;
      try {
        result = await installSkill(name, dir, skillId);
      } catch (e) {
        return c.json({ error: await failureAfterChown(e, dir, name) }, 400);
      }
      try {
        // installSkill writes files (and git objects) as the daemon (root under
        // user isolation), so hand ownership to the mind — otherwise it can't
        // modify or remove its own skill. No-op when isolation is disabled.
        await chownMindDir(dir, name);
      } catch (e) {
        return c.json({ error: errorMessage(e) }, 400);
      }
      return c.json({ ok: true, ...result });
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

      let result: Awaited<ReturnType<typeof updateSkill>>;
      try {
        result = await updateSkill(name, dir, skillId);
      } catch (e) {
        return c.json({ error: await failureAfterChown(e, dir, name) }, 400);
      }
      try {
        // Newly written files land as root under user isolation — re-chown so
        // the mind keeps ownership of its skill. No-op when isolation is off.
        await chownMindDir(dir, name);
      } catch (e) {
        return c.json({ error: errorMessage(e) }, 400);
      }
      return c.json(result);
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
        return c.json({ error: errorMessage(e) }, 400);
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
      return c.json({ error: await failureAfterChown(e, dir, name) }, 400);
    }
    try {
      // The removal commit's git objects are written as root under user
      // isolation — re-chown so the mind's later commits don't hit EACCES.
      // No-op when isolation is off.
      await chownMindDir(dir, name);
    } catch (e) {
      return c.json({ error: errorMessage(e) }, 400);
    }

    return c.json({ ok: true });
  });

export default app;
