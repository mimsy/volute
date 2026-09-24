import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { readGlobalConfig, writeGlobalConfig } from "../packages/daemon/src/lib/config/setup.js";
import {
  addMind,
  mindDir,
  removeMind,
  stateDir,
  voluteHome,
} from "../packages/daemon/src/lib/mind/registry.js";
import {
  backfillStandardSkills,
  seedSkillBackfillLedger,
} from "../packages/daemon/src/lib/skill-backfill.js";
import {
  importSkillFromDir,
  installSkill,
  mindSkillsDir,
  removeSharedSkill,
  uninstallSkill,
} from "../packages/daemon/src/lib/skills.js";
import { exec } from "../packages/daemon/src/lib/util/exec.js";
import { createMindGitRepo } from "./helpers/git.js";
import { cleanGitEnv } from "./helpers/test-git-env.js";

const SKILL = "bf-test-skill";

describe("backfillStandardSkills", () => {
  const minds: string[] = [];
  let savedDefaults: string[] | undefined;

  async function makeMind(name: string, stage: "seed" | "sprouted" = "sprouted") {
    await addMind(name, 4900 + minds.length, stage);
    await createMindGitRepo(mindDir(name));
    minds.push(name);
    return mindDir(name);
  }

  const ledgerEntry = (name: string) => {
    const path = join(stateDir(name), "skill-backfill.json");
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf-8"))[SKILL] : undefined;
  };

  const installed = (dir: string) => existsSync(join(mindSkillsDir(dir), SKILL));

  beforeEach(async () => {
    const src = join(voluteHome(), "tmp-bf-source", SKILL);
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "SKILL.md"), `---\nname: ${SKILL}\ndescription: test\n---\n\nbody\n`);
    await importSkillFromDir(src, "volute");
    const config = readGlobalConfig();
    savedDefaults = config.defaultSkills;
    writeGlobalConfig({ ...config, defaultSkills: [...(config.defaultSkills ?? []), SKILL] });
  });

  afterEach(async () => {
    for (const name of minds.splice(0)) {
      await removeMind(name);
      rmSync(mindDir(name), { recursive: true, force: true });
      rmSync(stateDir(name), { recursive: true, force: true });
    }
    await removeSharedSkill(SKILL).catch(() => {});
    rmSync(join(voluteHome(), "tmp-bf-source"), { recursive: true, force: true });
    writeGlobalConfig({ ...readGlobalConfig(), defaultSkills: savedDefaults });
  });

  it("installs the skill once into an existing mind, and respects a later uninstall", async () => {
    const dir = await makeMind("bf-mind-a");
    await backfillStandardSkills([SKILL]);
    assert.ok(installed(dir));
    assert.deepEqual(
      JSON.parse(readFileSync(join(stateDir("bf-mind-a"), "skill-backfill.json"), "utf-8")),
      { [SKILL]: "done" },
    );

    await uninstallSkill("bf-mind-a", dir, SKILL);
    await backfillStandardSkills([SKILL]);
    assert.ok(!installed(dir), "the mind's removal stands");
  });

  it("respects a removal made by hand, not through `volute skill uninstall`", async () => {
    const dir = await makeMind("bf-mind-d");
    await backfillStandardSkills([SKILL]);
    rmSync(join(mindSkillsDir(dir), SKILL), { recursive: true });
    await backfillStandardSkills([SKILL]);
    assert.ok(!installed(dir), "offered once means once");
  });

  it("leaves alone a mind that uninstalled the skill before the backfill existed", async () => {
    const dir = await makeMind("bf-mind-b");
    await installSkill("bf-mind-b", dir, SKILL);
    await uninstallSkill("bf-mind-b", dir, SKILL);
    await backfillStandardSkills([SKILL]);
    assert.ok(!installed(dir));
  });

  it("cleans up a failed install, doesn't record it, and succeeds on a later start", async () => {
    // A mind dir that isn't a git repo: installSkill copies the files, then fails to commit.
    await addMind("bf-mind-e", 4990, "sprouted");
    minds.push("bf-mind-e");
    const dir = mindDir("bf-mind-e");
    mkdirSync(join(dir, "home", ".claude", "skills"), { recursive: true });

    await backfillStandardSkills([SKILL]);
    assert.ok(!existsSync(join(mindSkillsDir(dir), SKILL)), "half-install removed");
    assert.equal(ledgerEntry("bf-mind-e"), undefined, "not recorded");

    await createMindGitRepo(dir);
    await backfillStandardSkills([SKILL]);
    assert.ok(installed(dir));
    assert.ok(existsSync(join(mindSkillsDir(dir), SKILL, ".upstream.json")));
  });

  it("counts a skill as present only when it came from the pool", async () => {
    const dir = await makeMind("bf-mind-f");
    const own = join(mindSkillsDir(dir), SKILL);
    mkdirSync(own, { recursive: true });
    writeFileSync(join(own, "SKILL.md"), "---\nname: mine\n---\n");
    await backfillStandardSkills([SKILL]);
    assert.equal(readFileSync(join(own, "SKILL.md"), "utf-8"), "---\nname: mine\n---\n");
    assert.equal(ledgerEntry("bf-mind-f"), undefined, "not recorded");
  });

  it("finishes an install a daemon restart cut short, instead of calling it the mind's own", async () => {
    const dir = await makeMind("bf-mind-g");
    // What a kill mid-install leaves: the marker, and files without .upstream.json.
    const half = join(mindSkillsDir(dir), SKILL);
    mkdirSync(half, { recursive: true });
    writeFileSync(join(half, "SKILL.md"), "partial");
    mkdirSync(stateDir("bf-mind-g"), { recursive: true });
    writeFileSync(
      join(stateDir("bf-mind-g"), "skill-backfill.json"),
      JSON.stringify({ [SKILL]: "installing" }),
    );

    await backfillStandardSkills([SKILL]);
    assert.ok(existsSync(join(half, ".upstream.json")));
    assert.notEqual(readFileSync(join(half, "SKILL.md"), "utf-8"), "partial");
  });

  it("respects a skill deleted by hand and committed, even without a ledger", async () => {
    const dir = await makeMind("bf-mind-h");
    await installSkill("bf-mind-h", dir, SKILL);
    rmSync(join(mindSkillsDir(dir), SKILL), { recursive: true });
    const env = cleanGitEnv();
    await exec("git", ["add", "-A"], { cwd: dir, env });
    await exec("git", ["commit", "-m", "not for me"], { cwd: dir, env });
    await backfillStandardSkills([SKILL]);
    assert.ok(!installed(dir));
  });

  it("respects a removal made under another template's skills dir", async () => {
    const dir = await makeMind("bf-mind-k");
    const env = cleanGitEnv();
    const other = join(dir, "home", ".agents", "skills", SKILL);
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, "SKILL.md"), "x");
    await exec("git", ["add", "-A"], { cwd: dir, env });
    await exec("git", ["commit", "-m", "had it"], { cwd: dir, env });
    rmSync(join(dir, "home", ".agents"), { recursive: true });
    await exec("git", ["add", "-A"], { cwd: dir, env });
    await exec("git", ["commit", "-m", "removed it"], { cwd: dir, env });
    await backfillStandardSkills([SKILL]);
    assert.ok(!installed(dir));
  });

  it("leaves minds created after the skill joined the defaults alone (e.g. --skills none)", async () => {
    const dir = await makeMind("bf-mind-i");
    seedSkillBackfillLedger("bf-mind-i", [SKILL]); // what createMind does
    await backfillStandardSkills([SKILL]);
    assert.ok(!installed(dir));
  });

  it("stops between minds when the daemon is shutting down", async () => {
    const dir = await makeMind("bf-mind-j");
    await backfillStandardSkills([SKILL], () => true);
    assert.ok(!installed(dir));
  });

  it("skips seeds, which get the default set when they sprout", async () => {
    const dir = await makeMind("bf-seed", "seed");
    await backfillStandardSkills([SKILL]);
    assert.ok(!installed(dir));
  });

  it("does nothing when the admin has taken the skill out of the defaults", async () => {
    const dir = await makeMind("bf-mind-c");
    writeGlobalConfig({ ...readGlobalConfig(), defaultSkills: savedDefaults ?? [] });
    await backfillStandardSkills([SKILL]);
    assert.ok(!installed(dir));
  });
});
