import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { resolveTemplate } from "../packages/daemon/src/lib/ai-service.js";
import { addSpirit, removeMind } from "../packages/daemon/src/lib/mind/registry.js";
import {
  getSpiritModel,
  spiritDir,
  syncSpiritTemplate,
} from "../packages/daemon/src/lib/mind/spirit.js";
import {
  composeTemplate,
  findTemplatesRoot,
  renderComposedPackageJson,
  sha256,
} from "../packages/daemon/src/lib/template/template.js";

const NOTICES_REL = "home/.local/hooks/pre-prompt/notices.ts";

/** The pre-#900 notices.ts, hash-pinned — see template-init-classification.test.ts. */
function preNoticesHook(): string {
  const content = readFileSync(
    resolve(import.meta.dirname, "fixtures/pre-0.58-notices.ts.txt"),
    "utf-8",
  );
  assert.equal(
    sha256(content),
    "1b2fffd2f3fd9f00638d561c99f90b8b73a9aeb2beec923cbafbd7c83b9037f6",
    "the pre-0.58.0 fixture has drifted",
  );
  return content;
}

/**
 * A spirit project on disk that syncSpiritTemplate() can run against without a
 * real `npm install`: a package.json matching the composed template plus a
 * node_modules/ dir, so the re-install check is a no-op.
 */
async function seedSpiritProject(): Promise<string> {
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
  return dir;
}

describe("the spirit's .local infrastructure", () => {
  afterEach(async () => {
    rmSync(spiritDir(), { recursive: true, force: true });
    await removeMind("volute").catch(() => {});
  });

  it("is refreshed on daemon start when it is an old shipped version", async () => {
    // The spirit cannot be repaired the way every other mind is: `volute mind
    // upgrade` 404s on it (`existsSync(mindDir(name))`, and the spirit lives
    // under voluteSystemDir()). syncSpiritTemplate — which runs on every daemon
    // start — is the only route it has. Without the backfill call there, the
    // spirit's hooks were the one set on the host that nothing could ever fix,
    // which is why it sat 505x 404ing on /history/notices for a fortnight.
    const dir = await seedSpiritProject();
    const hook = resolve(dir, NOTICES_REL);
    mkdirSync(resolve(hook, ".."), { recursive: true });
    writeFileSync(hook, preNoticesHook());

    await syncSpiritTemplate();

    const after = readFileSync(hook, "utf-8");
    assert.match(after, /\/api\/v1\/minds\//, "the spirit's drain hook must be repointed");
    assert.doesNotMatch(after, /\/api\/minds\//);
  });

  it("is added when the spirit predates the hook entirely", async () => {
    const dir = await seedSpiritProject();
    assert.equal(existsSync(resolve(dir, NOTICES_REL)), false);

    await syncSpiritTemplate();

    assert.ok(existsSync(resolve(dir, NOTICES_REL)), "the drain hook must be delivered");
  });

  it("never overwrites a hook the spirit wrote itself", async () => {
    // Same authorship rule as every other mind. The spirit is a mind.
    const dir = await seedSpiritProject();
    const hook = resolve(dir, NOTICES_REL);
    mkdirSync(resolve(hook, ".."), { recursive: true });
    writeFileSync(hook, "// I keep my own counsel\n");

    await syncSpiritTemplate();

    assert.equal(readFileSync(hook, "utf-8"), "// I keep my own counsel\n");
  });
});
