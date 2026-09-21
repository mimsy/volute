import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { resolveTemplate } from "../packages/daemon/src/lib/ai-service.js";
import { addSpirit, removeMind, stateDir } from "../packages/daemon/src/lib/mind/registry.js";
import {
  getSpiritModel,
  spiritDir,
  syncSpiritTemplate,
} from "../packages/daemon/src/lib/mind/spirit.js";
import {
  composeTemplate,
  findTemplatesRoot,
  renderComposedPackageJson,
} from "../packages/daemon/src/lib/template/template.js";

const LAYOUT: Record<string, { doc: string; skills: string }> = {
  claude: { doc: "CLAUDE.md", skills: ".claude/skills" },
  pi: { doc: "MINDS.md", skills: ".pi/skills" },
  codex: { doc: "AGENTS.md", skills: ".agents/skills" },
};

/** A spirit project syncSpiritTemplate() can run against without a real `npm install`. */
async function seedSpiritProject(): Promise<{ dir: string; template: string }> {
  const dir = spiritDir();
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(resolve(dir, "home/.config"), { recursive: true });

  const template = await resolveTemplate(getSpiritModel());
  const { composedDir } = composeTemplate(findTemplatesRoot(), template);
  cpSync(resolve(composedDir, "src"), resolve(dir, "src"), { recursive: true });
  const pkg = renderComposedPackageJson(composedDir, "volute");
  assert.ok(pkg);
  cpSync(pkg, resolve(dir, "package.json"));
  mkdirSync(resolve(dir, "node_modules"), { recursive: true });

  await addSpirit("volute", 4999, template, dir);
  return { dir, template };
}

describe("the spirit's home after a template switch", () => {
  afterEach(async () => {
    rmSync(spiritDir(), { recursive: true, force: true });
    rmSync(stateDir("volute"), { recursive: true, force: true });
    await removeMind("volute").catch(() => {});
  });

  // bardo, 2026-07-29 → 09-18: the spirit's switch swapped src/ and the registry
  // field but not home/, so a claude spirit kept codex's AGENTS.md, had no
  // .claude/settings.json (no startup-context hook), and held every skill in
  // .agents/skills where the claude SDK never looks. It ran seven weeks with no
  // CLI reference. The registry already said "claude", so only a check against the
  // home itself can repair it.
  it("is brought in line with the registered template", async () => {
    const { dir, template } = await seedSpiritProject();
    const home = resolve(dir, "home");
    // Lay the home out for a template other than the registered one.
    const stale = LAYOUT[template === "codex" ? "claude" : "codex"];
    const want = LAYOUT[template];
    writeFileSync(resolve(home, stale.doc), "# another runtime's mechanics\n");
    mkdirSync(resolve(home, stale.skills, "tending"), { recursive: true });
    writeFileSync(resolve(home, stale.skills, "tending/SKILL.md"), "---\nname: tending\n---\n");

    await syncSpiritTemplate();

    assert.equal(existsSync(resolve(home, stale.doc)), false);
    assert.ok(existsSync(resolve(home, want.doc)));
    assert.ok(existsSync(resolve(home, want.skills, "tending/SKILL.md")));
    assert.equal(existsSync(resolve(home, stale.skills)), false);
    assert.equal(existsSync(resolve(home, ".claude/settings.json")), template === "claude");
  });
});
