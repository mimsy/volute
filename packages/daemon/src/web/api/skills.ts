import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import AdmZip from "adm-zip";
import { Hono } from "hono";
import { readGlobalConfig, writeGlobalConfig } from "../../lib/config/setup.js";
import { getExtensionStandardSkills } from "../../lib/extensions.js";
import {
  getSharedSkill,
  getStandardSkillsWithExtensions,
  importSkillFromDir,
  isAutoUpdateSkillsEnabled,
  listFilesRecursive,
  listSharedSkills,
  removeSharedSkill,
  STANDARD_SKILLS,
  sharedSkillsDir,
} from "../../lib/skills.js";
import { type AuthEnv, requireAdmin } from "../middleware/auth.js";

const app = new Hono<AuthEnv>()
  .get("/", async (c) => {
    const skills = await listSharedSkills();
    return c.json(skills);
  })
  // Defaults routes must come before /:id to avoid being caught by the param route
  .get("/defaults/list", async (c) => {
    return c.json({ skills: getStandardSkillsWithExtensions() });
  })
  .put("/defaults/list", requireAdmin, async (c) => {
    const body = await c.req.json<{ skills: string[] }>();
    if (!Array.isArray(body.skills) || !body.skills.every((s) => typeof s === "string")) {
      return c.json({ error: "body.skills must be a string array" }, 400);
    }
    const config = readGlobalConfig();
    // Track which standard/extension skills were explicitly removed
    const allStandard = new Set([...STANDARD_SKILLS, ...getExtensionStandardSkills()]);
    const newSet = new Set(body.skills);
    const removed = [...allStandard].filter((s) => !newSet.has(s));
    const prevRemoved = new Set(config.removedDefaultSkills ?? []);
    for (const s of removed) prevRemoved.add(s);
    // Re-added skills should be cleared from the removed list
    for (const s of body.skills) prevRemoved.delete(s);
    writeGlobalConfig({
      ...config,
      defaultSkills: body.skills,
      removedDefaultSkills: [...prevRemoved],
    });
    return c.json({ skills: body.skills });
  })
  .post("/defaults/list", requireAdmin, async (c) => {
    const body = await c.req.json<{ skill: string }>();
    if (typeof body.skill !== "string" || !body.skill) {
      return c.json({ error: "body.skill must be a non-empty string" }, 400);
    }
    const current = getStandardSkillsWithExtensions();
    if (current.includes(body.skill)) {
      return c.json({ error: `"${body.skill}" is already a default skill` }, 409);
    }
    const config = readGlobalConfig();
    const updated = [...current, body.skill];
    const removed = (config.removedDefaultSkills ?? []).filter((s) => s !== body.skill);
    writeGlobalConfig({ ...config, defaultSkills: updated, removedDefaultSkills: removed });
    return c.json({ skills: updated });
  })
  .delete("/defaults/list/:skill", requireAdmin, async (c) => {
    const skill = c.req.param("skill");
    const current = getStandardSkillsWithExtensions();
    if (!current.includes(skill)) {
      return c.json({ error: `"${skill}" is not a default skill` }, 404);
    }
    const config = readGlobalConfig();
    const updated = current.filter((s) => s !== skill);
    const removed = new Set(config.removedDefaultSkills ?? []);
    removed.add(skill);
    writeGlobalConfig({ ...config, defaultSkills: updated, removedDefaultSkills: [...removed] });
    return c.json({ skills: updated });
  })
  .get("/auto-update", (c) => {
    return c.json({ enabled: isAutoUpdateSkillsEnabled() });
  })
  .put("/auto-update", requireAdmin, async (c) => {
    const body = await c.req.json<{ enabled: boolean }>();
    if (typeof body.enabled !== "boolean") {
      return c.json({ error: "body.enabled must be a boolean" }, 400);
    }
    const config = readGlobalConfig();
    writeGlobalConfig({ ...config, autoUpdateSkills: body.enabled });
    return c.json({ enabled: body.enabled });
  })
  .post("/upload", requireAdmin, async (c) => {
    const body = await c.req.parseBody();
    const file = body.file;
    if (!file || !(file instanceof File)) {
      return c.json({ error: "No file uploaded" }, 400);
    }

    if (!file.name.endsWith(".zip")) {
      return c.json({ error: "Only .zip files are accepted" }, 400);
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const tmpDir = mkdtempSync(join(tmpdir(), "volute-skill-upload-"));

    try {
      const zip = new AdmZip(buffer);

      // Validate zip entries don't escape the target directory (zip slip)
      for (const entry of zip.getEntries()) {
        const target = resolve(tmpDir, entry.entryName);
        if (!target.startsWith(tmpDir)) {
          return c.json({ error: "Invalid zip: paths must not escape archive" }, 400);
        }
      }

      zip.extractAllTo(tmpDir, true);

      // Find the directory containing SKILL.md (root-level or one-directory-deep)
      let skillDir: string | null = null;
      if (existsSync(join(tmpDir, "SKILL.md"))) {
        skillDir = tmpDir;
      } else {
        const entries = readdirSync(tmpDir, { withFileTypes: true }).filter((e) => e.isDirectory());
        for (const entry of entries) {
          if (existsSync(join(tmpDir, entry.name, "SKILL.md"))) {
            skillDir = join(tmpDir, entry.name);
            break;
          }
        }
      }

      if (!skillDir) {
        return c.json({ error: "No SKILL.md found in zip (checked root and one level deep)" }, 400);
      }

      const skill = await importSkillFromDir(skillDir, "upload");
      return c.json(skill);
    } catch (e) {
      if (e instanceof Error && e.message.includes("Invalid skill ID")) {
        return c.json({ error: e.message }, 400);
      }
      throw e;
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  })
  .get("/:id", async (c) => {
    const id = c.req.param("id");
    const skill = await getSharedSkill(id);
    if (!skill) return c.json({ error: "Skill not found" }, 404);

    const dir = join(sharedSkillsDir(), id);
    const files = listFilesRecursive(dir);
    return c.json({ ...skill, files });
  })
  .delete("/:id", requireAdmin, async (c) => {
    const id = c.req.param("id");
    try {
      await removeSharedSkill(id);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return c.json({ error: msg }, 404);
    }
    return c.json({ ok: true });
  });

export default app;
