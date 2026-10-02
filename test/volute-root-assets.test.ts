import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { describe, it } from "node:test";
import { resolveBuiltinBridge } from "../packages/daemon/src/lib/daemon/bridge-manager.js";
import { bundledExtensionPath } from "../packages/daemon/src/lib/extensions.js";
import { findSkillsRoot } from "../packages/daemon/src/lib/skills.js";
import { locateTemplatesRoot } from "../packages/daemon/src/lib/template/template.js";
import { linkedInstallVersion } from "../packages/daemon/src/lib/update-check.js";
import { voluteRoot } from "../packages/daemon/src/lib/util/volute-root.js";

const repoRoot = resolve(import.meta.dirname, "..");

describe("bundled asset lookups resolve under Volute's root (#1336)", () => {
  it("finds the package root in the dev tree", () => {
    assert.equal(voluteRoot(), repoRoot);
  });

  it("finds templates/ and skills/ in the dev tree", () => {
    assert.equal(locateTemplatesRoot(), resolve(repoRoot, "templates"));
    assert.equal(findSkillsRoot(), resolve(repoRoot, "skills"));
  });

  it("finds a built-in extension's files in the dev tree", () => {
    assert.equal(
      bundledExtensionPath("pages", "skills"),
      resolve(repoRoot, "packages/extensions/pages/skills"),
    );
    assert.ok(existsSync(bundledExtensionPath("pages", "skills")!));
  });

  it("finds a bridge script only in the root's dist/connectors/", () => {
    const tmp = mkdtempSync(resolve(tmpdir(), "volute-bridge-root-"));
    try {
      assert.equal(resolveBuiltinBridge("discord", tmp), null);
      mkdirSync(resolve(tmp, "dist/connectors"), { recursive: true });
      writeFileSync(resolve(tmp, "dist/connectors/discord-bridge.js"), "");
      assert.equal(
        resolveBuiltinBridge("discord", tmp),
        resolve(tmp, "dist/connectors/discord-bridge.js"),
      );
      assert.equal(resolveBuiltinBridge("discord", null), null);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("linkedInstallVersion (#1336)", () => {
  it("reads Volute's own package.json beside dist/, never an unrelated one further up", () => {
    const tmp = mkdtempSync(resolve(tmpdir(), "volute-linked-"));
    try {
      // An unrelated project with a version, within the old 4-level walk of the binary.
      writeFileSync(
        resolve(tmp, "package.json"),
        JSON.stringify({ name: "other", version: "9.9.9" }),
      );
      const checkout = resolve(tmp, "checkout");
      mkdirSync(resolve(checkout, "dist"), { recursive: true });
      const bin = resolve(checkout, "dist/cli.js");
      writeFileSync(bin, "");
      assert.equal(linkedInstallVersion(bin), null);

      writeFileSync(
        resolve(checkout, "package.json"),
        JSON.stringify({ name: "volute", version: "1.2.3" }),
      );
      assert.equal(linkedInstallVersion(bin), "1.2.3");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("no module walks up the tree for its own assets (#1336)", () => {
  // A walk-up from a module's location accepts whatever it finds above the install.
  // Asset lookups go through voluteRoot() instead. Matched: a module's own directory
  // taken from import.meta (either spelling) — the starting point of every walk-up.
  const ALLOWED: Record<string, string> = {
    "packages/daemon/src/lib/util/volute-root.ts": "the one place that finds the root",
    "packages/daemon/src/lib/db.ts": "fixed offsets to drizzle/ at module load",
    "src/commands/up.ts": "daemon.js beside the CLI bundle, a fixed offset",
  };
  const IDIOM =
    /dirname\((?:new URL\(import\.meta\.url\)\.pathname|fileURLToPath\(import\.meta\.url\))\)|=\s*import\.meta\.dirname\b/;

  function walk(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : [],
    );
  }

  it("finds none outside the allowlist", () => {
    const offenders = ["packages/daemon/src", "packages/cli/src", "src"]
      .flatMap((dir) => walk(resolve(repoRoot, dir)))
      .filter((f) => IDIOM.test(readFileSync(f, "utf-8")))
      .map((f) => relative(repoRoot, f))
      .filter((f) => !(f in ALLOWED));
    assert.deepEqual(offenders, []);
  });
});
