import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  addMind,
  findMind,
  mindDir,
  removeMind,
  setMindTemplateHash,
} from "../packages/daemon/src/lib/mind/registry.js";
import {
  computeMindTemplateHash,
  isTemplateStale,
} from "../packages/daemon/src/lib/mind/template-staleness.js";
import {
  composeTemplate,
  copyTemplateToDir,
  findTemplatesRoot,
} from "../packages/daemon/src/lib/template/template.js";
import { computeTemplateHash } from "../packages/daemon/src/lib/template/template-hash.js";

/** Build a pristine mind project at `destDir` from the given template. */
function buildPristineMind(destDir: string, templateName: string, mindName: string) {
  rmSync(destDir, { recursive: true, force: true });
  mkdirSync(destDir, { recursive: true });
  const { composedDir, manifest } = composeTemplate(findTemplatesRoot(), templateName);
  try {
    copyTemplateToDir(composedDir, destDir, mindName, manifest);
  } finally {
    rmSync(composedDir, { recursive: true, force: true });
  }
}

describe("computeMindTemplateHash", () => {
  it("matches computeTemplateHash for a pristine mind dir", () => {
    const name = `stale-pristine-${Date.now()}`;
    const dir = resolve(mindDir(name));
    buildPristineMind(dir, "claude", name);
    try {
      assert.equal(computeMindTemplateHash(dir, "claude", name), computeTemplateHash("claude"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not false-positive when the mind name is a substring of file content", () => {
    // "dev" appears in package.json ("dev" script, "devDependencies"). A naive
    // reverse-substitution of the mind name would mangle those and report a
    // pristine mind as stale. Forward-rendering must keep it current.
    const name = "dev";
    const dir = resolve(mindDir(name));
    buildPristineMind(dir, "claude", name);
    try {
      assert.equal(computeMindTemplateHash(dir, "claude", name), computeTemplateHash("claude"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("differs when a non-sentinel template file drifts", () => {
    // Drift a tracked file other than the src/agent.ts sentinel to confirm the
    // measurement (and the isTemplateStale memo signal) covers the whole set.
    const name = `stale-router-${Date.now()}`;
    const dir = resolve(mindDir(name));
    buildPristineMind(dir, "claude", name);
    try {
      const router = resolve(dir, "src", "lib", "router.ts");
      writeFileSync(router, `${readFileSync(router, "utf-8")}\n// drift\n`);
      assert.notEqual(computeMindTemplateHash(dir, "claude", name), computeTemplateHash("claude"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("differs when a source file is mutated", () => {
    const name = `stale-mutated-${Date.now()}`;
    const dir = resolve(mindDir(name));
    buildPristineMind(dir, "claude", name);
    try {
      const agent = resolve(dir, "src", "agent.ts");
      writeFileSync(agent, `${readFileSync(agent, "utf-8")}\n// drift\n`);
      assert.notEqual(computeMindTemplateHash(dir, "claude", name), computeTemplateHash("claude"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("differs when a template file is missing", () => {
    const name = `stale-missing-${Date.now()}`;
    const dir = resolve(mindDir(name));
    buildPristineMind(dir, "claude", name);
    try {
      rmSync(resolve(dir, "src", "agent.ts"));
      assert.notEqual(computeMindTemplateHash(dir, "claude", name), computeTemplateHash("claude"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("isTemplateStale", () => {
  const created: string[] = [];

  afterEach(async () => {
    for (const name of created.splice(0)) {
      try {
        await removeMind(name);
      } catch {}
      rmSync(resolve(mindDir(name)), { recursive: true, force: true });
    }
  });

  async function makeMind(name: string, mutate: boolean) {
    const dir = resolve(mindDir(name));
    buildPristineMind(dir, "claude", name);
    if (mutate) {
      const agent = resolve(dir, "src", "agent.ts");
      writeFileSync(agent, `${readFileSync(agent, "utf-8")}\n// drift\n`);
    }
    await addMind(name, 4100, undefined, "claude");
    created.push(name);
    return (await findMind(name))!;
  }

  it("reports a pristine mind as current", async () => {
    const entry = await makeMind(`stale-cur-${Date.now()}`, false);
    assert.equal(isTemplateStale(entry), false);
  });

  it("reports a drifted mind as stale even with no stored hash", async () => {
    const entry = await makeMind(`stale-old-${Date.now()}`, true);
    assert.equal(entry.templateHash, undefined);
    assert.equal(isTemplateStale(entry), true);
  });

  it("uses the stored hash as a fast path when it matches the current template", async () => {
    const name = `stale-fast-${Date.now()}`;
    await makeMind(name, true);
    // Even though the dir is drifted, a stored hash equal to the current
    // template short-circuits to "current" without re-reading the disk.
    await setMindTemplateHash(name, computeTemplateHash("claude"));
    assert.equal(isTemplateStale((await findMind(name))!), false);
  });

  it("never reports seeds, variants, or spirits", () => {
    assert.equal(
      isTemplateStale({
        name: "x",
        port: 1,
        created: "",
        running: false,
        mindType: "mind",
        stage: "seed",
      }),
      false,
    );
    assert.equal(
      isTemplateStale({
        name: "x",
        port: 1,
        created: "",
        running: false,
        mindType: "mind",
        parent: "p",
      }),
      false,
    );
    assert.equal(
      isTemplateStale({ name: "x", port: 1, created: "", running: false, mindType: "spirit" }),
      false,
    );
  });
});

describe("backfillTemplateHashes (on-disk measurement)", () => {
  const created: string[] = [];

  afterEach(async () => {
    for (const name of created.splice(0)) {
      try {
        await removeMind(name);
      } catch {}
      rmSync(resolve(mindDir(name)), { recursive: true, force: true });
    }
  });

  it("stamps a drifted mind with its real (non-current) hash, not a false-current one", async () => {
    const { backfillTemplateHashes } = await import("../packages/daemon/src/lib/version-notify.js");
    const name = `backfill-drift-${Date.now()}`;
    const dir = resolve(mindDir(name));
    buildPristineMind(dir, "claude", name);
    const agent = resolve(dir, "src", "agent.ts");
    writeFileSync(agent, `${readFileSync(agent, "utf-8")}\n// drift\n`);
    await addMind(name, 4100, undefined, "claude");
    created.push(name);

    await backfillTemplateHashes();

    const entry = await findMind(name);
    assert.ok(entry?.templateHash, "should stamp a hash");
    assert.notEqual(
      entry!.templateHash,
      computeTemplateHash("claude"),
      "a drifted mind must not be stamped as current",
    );
    assert.equal(isTemplateStale(entry!), true);
  });

  it("stamps a pristine mind with the current hash", async () => {
    const { backfillTemplateHashes } = await import("../packages/daemon/src/lib/version-notify.js");
    const name = `backfill-clean-${Date.now()}`;
    const dir = resolve(mindDir(name));
    buildPristineMind(dir, "claude", name);
    await addMind(name, 4100, undefined, "claude");
    created.push(name);

    await backfillTemplateHashes();

    const entry = await findMind(name);
    assert.equal(entry?.templateHash, computeTemplateHash("claude"));
    assert.equal(isTemplateStale(entry!), false);
  });
});
