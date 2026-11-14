import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { discoverLocalExtensions } from "../packages/daemon/src/lib/extensions.js";
import { voluteHome } from "../packages/daemon/src/lib/mind/registry.js";

/**
 * Local extensions live in `<home>/extensions/<dir>/`. One under development is a
 * symlink to its checkout, with its build in `dist/`: both used to be passed over
 * silently (a dirent reports a symlink as not a directory).
 */
describe("local extension discovery", () => {
  const base = resolve(voluteHome(), "extensions");
  let checkout: string;

  const manifest = (id: string) =>
    `export default { id: "${id}", name: "${id}", version: "0.0.0", routes: () => ({}) };\n`;

  before(() => {
    checkout = mkdtempSync(join(tmpdir(), "ext-checkout-"));
    mkdirSync(resolve(checkout, "dist"), { recursive: true });
    writeFileSync(resolve(checkout, "dist", "index.js"), manifest("linked"));

    mkdirSync(resolve(base, "plain"), { recursive: true });
    writeFileSync(resolve(base, "plain", "index.js"), manifest("plain"));
    symlinkSync(checkout, resolve(base, "linked"));
    mkdirSync(resolve(base, "empty"), { recursive: true });
    writeFileSync(resolve(base, "stray-file.js"), manifest("stray"));
  });

  after(() => {
    rmSync(base, { recursive: true, force: true });
    rmSync(checkout, { recursive: true, force: true });
  });

  it("finds a plain directory and a symlinked checkout built into dist/", async () => {
    const ids = (await discoverLocalExtensions()).map((m) => m.id).sort();
    assert.deepEqual(ids, ["linked", "plain"]);
  });
});
