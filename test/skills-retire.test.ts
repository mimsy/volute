import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { eq, sql } from "drizzle-orm";
import { readGlobalConfig, writeGlobalConfig } from "../packages/daemon/src/lib/config/setup.js";
import { getDb } from "../packages/daemon/src/lib/db.js";
import { pruneOrphanedExtensionSkills } from "../packages/daemon/src/lib/extensions.js";
import {
  addMind,
  stateDir,
  voluteHome,
  voluteSystemDir,
} from "../packages/daemon/src/lib/mind/registry.js";
import { minds, sharedSkills, systemEvents } from "../packages/daemon/src/lib/schema.js";
import {
  findSkillsRoot,
  getSharedSkill,
  hashSkillDir,
  importSkillFromDir,
  initDefaultSkills,
  installSkill,
  removeSharedSkill,
  retireSharedSkill,
  retireUnshippedMindSkills,
  retireWithDroppedBuiltinExtension,
  syncBuiltinSkills,
  syncExtensionSkills,
  uninstallSkill,
} from "../packages/daemon/src/lib/skills.js";
import { getCurrentVersion } from "../packages/daemon/src/lib/update-check.js";
import { exec } from "../packages/daemon/src/lib/util/exec.js";
import { createMindGitRepo } from "./helpers/git.js";

const mindName = "retire-test-mind";
const mindDir = () => join(voluteHome(), "minds", mindName);
const skillDir = (id: string) => join(mindDir(), "home", ".claude", "skills", id);
const ledgerPath = () => join(voluteSystemDir(), "skill-ledger.json");
const readLedger = () => JSON.parse(readFileSync(ledgerPath(), "utf-8"));

/** Record in the host's skill ledger that `author` shipped `id` at `versions`. */
function recordShipped(
  id: string,
  author: string,
  versions: string[],
  extra: { hashes?: string[]; builtin?: boolean } = {},
) {
  const ledger = existsSync(ledgerPath()) ? readLedger() : { shipped: {}, retired: {} };
  ledger.shipped[id] = { author, versions, hashes: [], ...extra };
  writeFileSync(ledgerPath(), JSON.stringify(ledger));
}

/** A skill with a hook and a bin command, so its uninstall has shims to remove. */
function wiredSkillSource(id: string, root = join(voluteHome(), "tmp-retire-source")): string {
  const dir = join(root, id);
  mkdirSync(join(dir, "scripts"), { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${id}\ndescription: retires\nmetadata:\n  bin: scripts/${id}-cmd.sh\n  hooks:\n    pre-prompt: scripts/hook.sh\n---\n\n# ${id}\n`,
  );
  writeFileSync(join(dir, "scripts", `${id}-cmd.sh`), "#!/bin/sh\necho hi\n");
  writeFileSync(join(dir, "scripts", "hook.sh"), "#!/bin/sh\n");
  return dir;
}

async function retiredNotices() {
  const db = await getDb();
  const rows = await db.select().from(systemEvents).where(eq(systemEvents.mind, mindName));
  return rows.filter((r) => JSON.parse(r.meta ?? "{}").subtype === "skill_retired");
}

/** What draining the notices into a turn does — or, with `dropped`, the next-turn cap. */
async function settleNotices(dropped = false) {
  const db = await getDb();
  await db.run(
    dropped
      ? sql`UPDATE system_events SET delivered_at = datetime('now'), meta = json_set(meta, '$.dropped', 1) WHERE mind = ${mindName}`
      : sql`UPDATE system_events SET delivered_at = datetime('now') WHERE mind = ${mindName}`,
  );
}

const handled = () => {
  const path = join(stateDir(mindName), "retired-skills.json");
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf-8")).handled : [];
};

const shimNames = () => [
  ...readdirSync(join(mindDir(), "home", ".local", "hooks"), { recursive: true }).map(String),
  ...(existsSync(join(mindDir(), "home", ".local", "bin"))
    ? readdirSync(join(mindDir(), "home", ".local", "bin"))
    : []),
];

async function cleanup() {
  const db = await getDb();
  await db.delete(sharedSkills);
  await db.delete(systemEvents).where(eq(systemEvents.mind, mindName));
  await db.delete(minds).where(eq(minds.name, mindName));
  for (const dir of [
    join(voluteHome(), "skills"),
    join(voluteHome(), "tmp-retire-source"),
    mindDir(),
    stateDir(mindName),
  ]) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
  rmSync(ledgerPath(), { force: true });
}

describe("retiring a mind's copy of a skill Volute no longer ships (#971)", () => {
  beforeEach(async () => {
    await cleanup();
    await createMindGitRepo(mindDir());
    await addMind(mindName, 4321);
    const source = wiredSkillSource("old-tool");
    await importSkillFromDir(source, "volute");
    recordShipped("old-tool", "volute", ["0.0.1"], { hashes: [hashSkillDir(source)] });
    await installSkill(mindName, mindDir(), "old-tool");
  });
  afterEach(cleanup);

  it("uninstalls an unmodified copy, shims and all, through the ordinary uninstall", async () => {
    assert.ok(
      shimNames().some((n) => n.includes("old-tool")),
      "the install gave shims",
    );
    assert.equal(await retireSharedSkill("old-tool", "volute"), true);
    await retireUnshippedMindSkills();

    assert.ok(!existsSync(skillDir("old-tool")));
    assert.deepEqual(
      shimNames().filter((n) => n.includes("old-tool")),
      [],
    );
    const head = await exec("git", ["log", "-1", "--format=%s"], { cwd: mindDir() });
    assert.equal(head.trim(), "Uninstall skill: old-tool");
    assert.equal((await retiredNotices()).length, 0, "an uninstalled copy needs no notice");
    assert.deepEqual(handled(), ["old-tool"]);
    await retireUnshippedMindSkills(); // a second start finds nothing to do
  });

  it("never commits what the mind had staged, or its own unstaged hook edits", async () => {
    const hook = join(mindDir(), "home", ".local", "hooks", "pre-prompt", "mine.sh");
    writeFileSync(hook, "#!/bin/sh\n");
    await exec("git", ["add", "-f", "home/.local/hooks/pre-prompt/mine.sh"], { cwd: mindDir() });
    await exec("git", ["commit", "-m", "my hook"], { cwd: mindDir() });
    writeFileSync(hook, "#!/bin/sh\necho half-written\n");
    writeFileSync(join(mindDir(), "home", "draft.md"), "half a thought\n");
    await exec("git", ["add", "-f", "home/draft.md"], { cwd: mindDir() });
    await retireSharedSkill("old-tool", "volute");
    await retireUnshippedMindSkills();

    assert.ok(!existsSync(skillDir("old-tool")));
    const committed = await exec("git", ["show", "--name-only", "--format=", "HEAD"], {
      cwd: mindDir(),
    });
    assert.ok(committed.includes("old-tool"), committed);
    assert.ok(!committed.includes("draft.md"), committed);
    assert.ok(!committed.includes("mine.sh"), committed);
    const tracked = await exec("git", ["ls-files", "home/.local"], { cwd: mindDir() });
    assert.ok(!tracked.includes("old-tool"), `the shim removals were committed: ${tracked}`);
    const staged = await exec("git", ["diff", "--cached", "--name-only"], { cwd: mindDir() });
    assert.equal(staged.trim(), "home/draft.md");
  });

  it("keeps an edited copy, and tells the mind once — counted only when it reached a turn", async () => {
    const md = join(skillDir("old-tool"), "SKILL.md");
    writeFileSync(md, `${readFileSync(md, "utf-8")}\nMy own note.\n`);
    await retireSharedSkill("old-tool", "volute");

    await retireUnshippedMindSkills();
    await retireUnshippedMindSkills();
    assert.match(readFileSync(md, "utf-8"), /My own note/);
    let notices = await retiredNotices();
    assert.equal(notices.length, 1, "a pending notice is not sent again");
    assert.equal(
      notices[0].body,
      "old-tool is no longer shipped with Volute. Your edited copy stays yours; it may call things that no longer exist.",
    );
    assert.deepEqual(handled(), [], "not told until it reached a turn");

    await settleNotices();
    await retireUnshippedMindSkills();
    await retireUnshippedMindSkills();
    notices = await retiredNotices();
    assert.equal(notices.length, 1);
    assert.deepEqual(handled(), ["old-tool"]);
    assert.ok(existsSync(md));
  });

  it("tells the mind again when the next-turn cap dropped the notice unread", async () => {
    writeFileSync(join(skillDir("old-tool"), "notes.md"), "mine\n");
    await retireSharedSkill("old-tool", "volute");
    await retireUnshippedMindSkills();
    await settleNotices(true);
    await retireUnshippedMindSkills();
    assert.equal((await retiredNotices()).length, 2);
    assert.deepEqual(handled(), []);
  });

  it("counts a notice the purge of old delivered rows removed as given", async () => {
    writeFileSync(join(skillDir("old-tool"), "notes.md"), "mine\n");
    await retireSharedSkill("old-tool", "volute");
    await retireUnshippedMindSkills();
    const db = await getDb();
    await db.delete(systemEvents).where(eq(systemEvents.mind, mindName));
    await retireUnshippedMindSkills();
    assert.equal((await retiredNotices()).length, 0);
    assert.deepEqual(handled(), ["old-tool"]);
  });

  it("tells the mind afresh when a skill that shipped again is retired again", async () => {
    writeFileSync(join(skillDir("old-tool"), "notes.md"), "mine\n");
    await retireSharedSkill("old-tool", "volute");
    await retireUnshippedMindSkills();
    await settleNotices();
    await retireUnshippedMindSkills();
    assert.deepEqual(handled(), ["old-tool"]);

    const source = wiredSkillSource("old-tool");
    await importSkillFromDir(source, "volute");
    recordShipped("old-tool", "volute", ["0.0.1"], { hashes: [hashSkillDir(source)] });
    await retireUnshippedMindSkills();
    assert.deepEqual(handled(), []);
    assert.equal(await retireSharedSkill("old-tool", "volute"), true);
    await retireUnshippedMindSkills();
    assert.equal((await retiredNotices()).length, 2);
  });

  it("waits out a merge in progress rather than commit into it", async () => {
    const head = (await exec("git", ["rev-parse", "HEAD"], { cwd: mindDir() })).trim();
    writeFileSync(join(mindDir(), ".git", "MERGE_HEAD"), `${head}\n`);
    await retireSharedSkill("old-tool", "volute");
    await retireUnshippedMindSkills();
    assert.ok(existsSync(join(skillDir("old-tool"), "SKILL.md")), "nothing removed mid-merge");
    assert.ok(shimNames().some((n) => n.includes("old-tool")));
    assert.deepEqual(handled(), []);

    rmSync(join(mindDir(), ".git", "MERGE_HEAD"));
    await retireUnshippedMindSkills();
    assert.ok(!existsSync(skillDir("old-tool")));
  });

  it("treats a deleted file as an edit", async () => {
    rmSync(join(skillDir("old-tool"), "scripts", "hook.sh"));
    await retireSharedSkill("old-tool", "volute");
    await retireUnshippedMindSkills();
    assert.ok(existsSync(skillDir("old-tool")));
    assert.equal((await retiredNotices()).length, 1);
  });

  it("treats an edited shim as an edit", async () => {
    const shim = join(mindDir(), "home", ".local", "bin", "old-tool-cmd");
    writeFileSync(shim, `${readFileSync(shim, "utf-8")}# mine\n`);
    await retireSharedSkill("old-tool", "volute");
    await retireUnshippedMindSkills();
    assert.ok(existsSync(skillDir("old-tool")));
    assert.ok(existsSync(shim));
    assert.equal((await retiredNotices()).length, 1);
  });

  it("treats a shim the mind deleted as an edit", async () => {
    rmSync(join(mindDir(), "home", ".local", "bin", "old-tool-cmd"));
    await retireSharedSkill("old-tool", "volute");
    await retireUnshippedMindSkills();
    assert.ok(existsSync(skillDir("old-tool")));
    assert.equal((await retiredNotices()).length, 1);
  });

  it("keeps a copy it can't vouch for, saying so", async () => {
    // What an older daemon left: no copy of the shipped version anywhere in the repo.
    const refs = await exec("git", ["for-each-ref", "--format=%(refname)", "refs/volute/"], {
      cwd: mindDir(),
    });
    for (const ref of refs.trim().split("\n").filter(Boolean)) {
      await exec("git", ["update-ref", "-d", ref], { cwd: mindDir() });
    }
    const upstreamPath = join(skillDir("old-tool"), ".upstream.json");
    const upstream = JSON.parse(readFileSync(upstreamPath, "utf-8"));
    writeFileSync(upstreamPath, JSON.stringify({ ...upstream, baseCommit: "0".repeat(40) }));
    await retireSharedSkill("old-tool", "volute");

    await retireUnshippedMindSkills();
    assert.ok(existsSync(skillDir("old-tool")));
    const notices = await retiredNotices();
    assert.equal(notices.length, 1);
    assert.match(notices[0].body ?? "", /couldn't confirm your copy is unchanged/);
  });

  it("never uninstalls a copy unless the ledger saw Volute ship that content", async () => {
    // What a same-named skill from another author looks like: a faithful copy of its own
    // base, but nothing Volute shipped.
    recordShipped("old-tool", "volute", ["0.0.1"], { hashes: ["f".repeat(64)] });
    await retireSharedSkill("old-tool", "volute");
    await retireUnshippedMindSkills();
    assert.ok(existsSync(join(skillDir("old-tool"), "SKILL.md")));
    const notices = await retiredNotices();
    assert.equal(notices.length, 1);
    assert.match(notices[0].body ?? "", /couldn't confirm your copy is unchanged/);
  });

  it("leaves the skill whole when the uninstall's commit fails, and finishes once it can", async () => {
    const status = () => exec("git", ["status", "--porcelain"], { cwd: mindDir() });
    const before = await status();
    const hook = join(mindDir(), ".git", "hooks", "pre-commit");
    mkdirSync(dirname(hook), { recursive: true });
    writeFileSync(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    await retireSharedSkill("old-tool", "volute");

    await retireUnshippedMindSkills();
    assert.ok(existsSync(join(skillDir("old-tool"), "SKILL.md")));
    assert.ok(
      shimNames().some((n) => n.includes("old-tool")),
      "its shims stay too",
    );
    assert.equal(await status(), before, "nothing half-done in the tree or the index");
    assert.deepEqual(handled(), []);

    rmSync(hook);
    await retireUnshippedMindSkills();
    assert.ok(!existsSync(skillDir("old-tool")));
    assert.deepEqual(handled(), ["old-tool"]);
  });

  it("keeps the ledger's evidence when the pool removal fails", async () => {
    const db = await getDb();
    await db.run(
      sql`CREATE TRIGGER retire_test_block BEFORE DELETE ON shared_skills BEGIN SELECT RAISE(ABORT, 'blocked'); END`,
    );
    try {
      await assert.rejects(() => retireSharedSkill("old-tool", "volute"));
    } finally {
      await db.run(sql`DROP TRIGGER retire_test_block`);
    }
    assert.ok(await getSharedSkill("old-tool"));
    assert.deepEqual(readLedger().retired, {});
    assert.equal(readLedger().shipped["old-tool"]?.author, "volute");
    assert.equal(await retireSharedSkill("old-tool", "volute"), true, "and retires it later");
  });

  it("leaves a copy alone whose pool entry was merely deleted, not retired", async () => {
    const db = await getDb();
    await db.delete(sharedSkills).where(eq(sharedSkills.id, "old-tool"));
    await retireUnshippedMindSkills();
    assert.ok(existsSync(skillDir("old-tool")));
    assert.equal((await retiredNotices()).length, 0);
  });

  it("forgets a retirement when the skill ships again", async () => {
    await retireSharedSkill("old-tool", "volute");
    await importSkillFromDir(wiredSkillSource("old-tool"), "volute");
    await retireUnshippedMindSkills();
    assert.ok(existsSync(skillDir("old-tool")));
    assert.deepEqual(readLedger().retired, {});
  });

  it("retires only a pool row under the author the ledger says shipped it", async () => {
    assert.equal(await retireSharedSkill("old-tool", "ext:pages"), false);
    recordShipped("old-tool", "ext:pages", ["0.0.1", "0.0.1"]);
    assert.equal(await retireSharedSkill("old-tool", "volute"), false);
    assert.equal(await retireSharedSkill("missing", "volute"), false);
    assert.ok(await getSharedSkill("old-tool"));
    assert.deepEqual(readLedger().retired, {});
  });
});

describe("syncBuiltinSkills retires built-ins it no longer ships (#971)", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("retires a built-in an earlier Volute shipped, from the pool and the default skills", async () => {
    await importSkillFromDir(wiredSkillSource("gone-builtin"), "volute");
    recordShipped("gone-builtin", "volute", ["0.0.1"]);
    writeGlobalConfig({ ...readGlobalConfig(), defaultSkills: ["memory", "gone-builtin"] });

    await syncBuiltinSkills();
    await initDefaultSkills();

    assert.equal(await getSharedSkill("gone-builtin"), undefined);
    assert.ok(!existsSync(join(voluteHome(), "skills", "gone-builtin")));
    assert.ok(!readGlobalConfig().defaultSkills?.includes("gone-builtin"));
    const ledger = readLedger();
    assert.deepEqual(ledger.retired, { "gone-builtin": { author: "volute", hashes: [] } });
    assert.equal(ledger.shipped.memory.author, "volute");
    assert.deepEqual(ledger.shipped.memory.versions, [getCurrentVersion()]);
    assert.deepEqual(ledger.shipped.memory.hashes, [
      hashSkillDir(join(findSkillsRoot(), "memory")),
    ]);
    assert.ok(await getSharedSkill("memory"), "shipped built-ins stay");
  });

  it("never retires on a downgrade, or at the version that last shipped it", async () => {
    await importSkillFromDir(wiredSkillSource("gone-builtin"), "volute");
    for (const version of ["999.0.0", getCurrentVersion()]) {
      recordShipped("gone-builtin", "volute", [version]);
      await syncBuiltinSkills();
      assert.ok(await getSharedSkill("gone-builtin"), `kept at ${version}`);
      assert.deepEqual(readLedger().shipped["gone-builtin"].versions, [version]);
    }
  });

  it("never retires a later skill under a retired built-in's id — the spirit's, say", async () => {
    await importSkillFromDir(wiredSkillSource("gone-builtin"), "volute");
    recordShipped("gone-builtin", "volute", ["0.0.1"]);
    await syncBuiltinSkills();
    assert.equal(await getSharedSkill("gone-builtin"), undefined);

    await importSkillFromDir(wiredSkillSource("gone-builtin"), "volute"); // the spirit publishes
    await syncBuiltinSkills();
    assert.ok(await getSharedSkill("gone-builtin"));
  });

  it("never retires without the ledger's word: no record, or the spirit's own 'volute' skill", async () => {
    await importSkillFromDir(wiredSkillSource("spirit-own"), "volute");
    await syncBuiltinSkills();
    assert.ok(await getSharedSkill("spirit-own"));
    assert.deepEqual(readLedger().retired, {});
  });
});

describe("syncExtensionSkills retires skills an extension stops shipping (#971)", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  const extSkills = () => join(voluteHome(), "tmp-retire-source", "ext");
  const ext = { builtin: false };

  it("retires its own dropped skill once its versions move past, and nothing else", async () => {
    wiredSkillSource("kept", extSkills());
    wiredSkillSource("dropped", extSkills());
    await importSkillFromDir(wiredSkillSource("other-ext"), "ext:other");
    await syncExtensionSkills("fake", "1.0.0", extSkills(), ext);
    assert.ok(await getSharedSkill("dropped"));

    rmSync(join(extSkills(), "dropped"), { recursive: true });
    await syncExtensionSkills("fake", "1.0.0", extSkills(), ext);
    assert.ok(await getSharedSkill("dropped"), "the same versions are not past");

    await syncExtensionSkills("fake", "1.1.0", extSkills(), ext);
    assert.equal(await getSharedSkill("dropped"), undefined);
    assert.ok(await getSharedSkill("kept"));
    assert.ok(await getSharedSkill("other-ext"), "another extension's skill is not this one's");
    assert.deepEqual(readLedger().retired, {
      dropped: { author: "ext:fake", hashes: [hashSkillDir(wiredSkillSource("dropped"))] },
    });
  });

  it("ends a retirement when the skill ships again, even if its import fails", async () => {
    wiredSkillSource("back.up", extSkills()); // an id the import refuses
    const ledger = { shipped: {}, retired: { "back.up": { author: "ext:fake" } } };
    writeFileSync(ledgerPath(), JSON.stringify(ledger));
    await syncExtensionSkills("fake", "1.0.0", extSkills(), ext);
    assert.equal(await getSharedSkill("back.up"), undefined);
    assert.deepEqual(readLedger().retired, {});
    assert.equal(readLedger().shipped["back.up"].author, "ext:fake");
  });

  it("never retires when the extension went back, however far Volute moved on", async () => {
    await importSkillFromDir(wiredSkillSource("dropped"), "ext:fake");
    recordShipped("dropped", "ext:fake", ["0.0.1", "2.0.0"]);
    wiredSkillSource("kept", extSkills());
    await syncExtensionSkills("fake", "1.0.0", extSkills(), ext);
    assert.ok(await getSharedSkill("dropped"));
    assert.deepEqual(readLedger().retired, {});
  });

  it("numbers a skill that ships again on from where it left the pool", async () => {
    const dir = wiredSkillSource("again", extSkills());
    await syncExtensionSkills("fake", "1.0.0", extSkills(), ext);
    writeFileSync(join(dir, "SKILL.md"), `${readFileSync(join(dir, "SKILL.md"), "utf-8")}\nv2\n`);
    await syncExtensionSkills("fake", "1.0.0", extSkills(), ext);
    assert.equal((await getSharedSkill("again"))?.version, 2);

    const kept = join(voluteHome(), "tmp-retire-source", "kept-again");
    rmSync(kept, { recursive: true, force: true });
    mkdirSync(dirname(kept), { recursive: true });
    await exec("mv", [dir, kept]);
    await syncExtensionSkills("fake", "1.1.0", extSkills(), ext);
    assert.equal(await getSharedSkill("again"), undefined);

    await exec("mv", [kept, dir]);
    await syncExtensionSkills("fake", "1.2.0", extSkills(), ext);
    assert.equal((await getSharedSkill("again"))?.version, 3, "minds' v2 copies still update");
    assert.deepEqual(readLedger().retired, {});
  });

  it("leaves a skill another of Volute's sources holds alone, then is handed it", async () => {
    const holder = join(voluteHome(), "tmp-retire-source", "holder");
    const holderCopy = wiredSkillSource("moved", holder);
    wiredSkillSource("moved", extSkills());
    await syncExtensionSkills("holder", "1.0.0", holder, ext);

    for (let start = 0; start < 2; start++) {
      await syncExtensionSkills("fake", "1.0.0", extSkills(), ext);
      assert.equal((await getSharedSkill("moved"))?.author, "ext:holder");
      assert.equal(readLedger().shipped.moved.author, "ext:holder", "the record is not flipped");
    }

    // The holder stops shipping it: handed over, not retired from minds.
    rmSync(holderCopy, { recursive: true });
    await syncExtensionSkills("holder", "1.1.0", holder, ext);
    assert.equal(await getSharedSkill("moved"), undefined);
    assert.deepEqual(readLedger().retired, {});

    await syncExtensionSkills("fake", "1.0.0", extSkills(), ext);
    const row = await getSharedSkill("moved");
    assert.equal(row?.author, "ext:fake");
    assert.equal(row?.version, 2);
  });

  it("retires nothing when its skills dir can't be read", async () => {
    wiredSkillSource("kept", extSkills());
    await syncExtensionSkills("fake", "1.0.0", extSkills(), ext);
    rmSync(extSkills(), { recursive: true });
    await syncExtensionSkills("fake", "2.0.0", extSkills(), ext);
    assert.ok(await getSharedSkill("kept"));
  });
});

describe("skills of a built-in extension Volute drops (#971)", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  const extSkills = () => join(voluteHome(), "tmp-retire-source", "builtin-ext");

  it("retires them once Volute is past the version that shipped them", async () => {
    wiredSkillSource("ext-tool", extSkills());
    await syncExtensionSkills("gone", "1.0.0", extSkills(), { builtin: true });
    assert.equal(readLedger().shipped["ext-tool"].builtin, true);
    assert.equal(
      await retireWithDroppedBuiltinExtension("ext-tool", "ext:gone"),
      false,
      "not at the Volute that shipped it",
    );

    recordShipped("ext-tool", "ext:gone", ["0.0.1", "1.0.0"], { builtin: true });
    await pruneOrphanedExtensionSkills(new Set(["pages"]));
    assert.equal(await getSharedSkill("ext-tool"), undefined);
    assert.deepEqual(Object.keys(readLedger().retired), ["ext-tool"]);
  });

  it("only removes them from the pool when the extension is still a built-in, or never was", async () => {
    for (const [id, builtin, builtins] of [
      ["failed-load", true, new Set(["gone"])],
      ["third-party", false, new Set<string>()],
    ] as const) {
      await importSkillFromDir(wiredSkillSource(id), "ext:gone");
      recordShipped(id, "ext:gone", ["0.0.1", "1.0.0"], { builtin });
      await pruneOrphanedExtensionSkills(builtins);
      assert.equal(await getSharedSkill(id), undefined, `${id} leaves the pool`);
      assert.deepEqual(readLedger().retired, {}, `${id} is not retired from minds`);
    }
  });
});

describe("removing a skill by hand, as a host does for one retired before the ledger (#971)", () => {
  beforeEach(async () => {
    await cleanup();
    await createMindGitRepo(mindDir());
    await addMind(mindName, 4321);
  });
  afterEach(cleanup);

  it("uninstalls it from a mind, legacy shims and all, and drops it from the pool for good", async () => {
    // As an old daemon left shared-files: in the pool under "volute", nothing in the ledger.
    await importSkillFromDir(wiredSkillSource("shared-files"), "volute");
    await installSkill(mindName, mindDir(), "shared-files");
    const hooks = join(mindDir(), "home", ".local", "hooks", "pre-prompt");
    writeFileSync(
      join(hooks, "50-shared-files.sh"),
      readFileSync(join(hooks, "zz-shared-files.sh"), "utf-8"),
    );
    rmSync(ledgerPath(), { force: true });

    await uninstallSkill(mindName, mindDir(), "shared-files");
    assert.ok(!existsSync(skillDir("shared-files")));
    assert.deepEqual(
      shimNames().filter((n) => n.includes("shared-files")),
      [],
    );
    const head = await exec("git", ["log", "-1", "--format=%s"], { cwd: mindDir() });
    assert.equal(head.trim(), "Uninstall skill: shared-files");
    const status = await exec("git", ["status", "--porcelain"], { cwd: mindDir() });
    assert.ok(!status.includes("shared-files"), status);

    await removeSharedSkill("shared-files");
    await syncBuiltinSkills();
    assert.equal(await getSharedSkill("shared-files"), undefined);
    assert.ok(!existsSync(join(voluteHome(), "skills", "shared-files")));
  });

  it("uninstalls one whose shims the mind's .gitignore keeps out of the repo", async () => {
    writeFileSync(
      join(mindDir(), ".gitignore"),
      readFileSync(join(process.cwd(), "templates", "_base", "gitignore")),
    );
    await exec("git", ["add", ".gitignore"], { cwd: mindDir() });
    await exec("git", ["commit", "-q", "-m", "ignore"], { cwd: mindDir() });
    await importSkillFromDir(wiredSkillSource("ignored-shims"), "volute");
    await installSkill(mindName, mindDir(), "ignored-shims");
    const tracked = await exec("git", ["ls-files"], { cwd: mindDir() });
    assert.ok(tracked.includes("ignored-shims/SKILL.md") && !tracked.includes(".local"), tracked);

    await uninstallSkill(mindName, mindDir(), "ignored-shims");
    assert.ok(!existsSync(skillDir("ignored-shims")));
    assert.deepEqual(
      shimNames().filter((n) => n.includes("ignored-shims")),
      [],
    );
    const head = await exec("git", ["log", "-1", "--format=%s"], { cwd: mindDir() });
    assert.equal(head.trim(), "Uninstall skill: ignored-shims");
    assert.equal(await exec("git", ["status", "--porcelain"], { cwd: mindDir() }), "");
  });

  it("uninstalls a copy the mind's repo never tracked", async () => {
    await importSkillFromDir(wiredSkillSource("untracked"), "volute");
    await installSkill(mindName, mindDir(), "untracked");
    await exec("git", ["rm", "-r", "-q", "--cached", "home"], { cwd: mindDir() });
    await exec("git", ["commit", "-q", "-m", "untrack"], { cwd: mindDir() });
    const head = await exec("git", ["rev-parse", "HEAD"], { cwd: mindDir() });

    await uninstallSkill(mindName, mindDir(), "untracked");
    assert.ok(!existsSync(skillDir("untracked")));
    assert.equal(await exec("git", ["rev-parse", "HEAD"], { cwd: mindDir() }), head);
  });
});
