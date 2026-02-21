import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import AdmZip from "adm-zip";
import { Hono } from "hono";
import {
  getSharedSkill,
  importSkillFromDir,
  listFilesRecursive,
  listSharedSkills,
  removeSharedSkill,
  sharedSkillsDir,
} from "../../lib/skills.js";
import { type AuthEnv, requireAdmin } from "../middleware/auth.js";

const app = new Hono<AuthEnv>()
  .get("/", async (c) => {
    const skills = await listSharedSkills();
    return c.json(skills);
  })
  .get("/:id", async (c) => {
    const id = c.req.param("id");
    const skill = await getSharedSkill(id);
    if (!skill) return c.json({ error: "Skill not found" }, 404);

    const dir = join(sharedSkillsDir(), id);
    const files = listFilesRecursive(dir);
    return c.json({ ...skill, files });
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
