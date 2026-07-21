import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build, type Options } from "tsup";
import tsupConfig from "../tsup.config.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Built-in extensions are bundled by tsup into ESM chunks and loaded at runtime
 * via `discoverBuiltinExtensions`. If a dependency breaks under tsup's ESM
 * bundling (e.g. jsdom's dynamic `require("path")`, pulled in by
 * isomorphic-dompurify), the chunk throws on import and the extension is
 * *silently* dropped — invisible in dev (which runs the TS source via tsx) but
 * broken in every published build.
 *
 * This test builds the real bundle and imports each built-in extension chunk to
 * prove they all load. It uses the actual `tsup.config` so a missing `external`
 * entry is caught.
 */
test("built-in extensions load from the tsup bundle", async () => {
  // Build inside the repo so external bare imports (isomorphic-dompurify) still
  // resolve from the repo's node_modules.
  const outDir = mkdtempSync(resolve(repoRoot, ".bundle-test-"));
  try {
    const jsConfig = (Array.isArray(tsupConfig) ? tsupConfig[0] : tsupConfig) as Options;
    await build({ ...jsConfig, outDir, dts: false, silent: true, clean: true });

    // Find the compiled discoverBuiltinExtensions and the chunks it imports.
    const files = readdirSync(outDir).filter((f) => f.endsWith(".js"));
    let specifiers: string[] | null = null;
    for (const f of files) {
      const src = readFileSync(resolve(outDir, f), "utf-8");
      const start = src.indexOf("async function discoverBuiltinExtensions");
      if (start === -1) continue;
      const rest = src.slice(start);
      const end = rest.indexOf("async function discoverInstalledExtensions");
      const region = end === -1 ? rest : rest.slice(0, end);
      specifiers = [...region.matchAll(/import\("(\.\/[^"]+)"\)/g)].map((m) => m[1]);
      break;
    }

    assert.ok(specifiers, "could not locate discoverBuiltinExtensions in the bundle");
    assert.equal(specifiers.length, 3, "expected 3 built-in extension chunk imports");

    const ids = new Set<string>();
    for (const spec of specifiers) {
      const mod = await import(pathToFileURL(resolve(outDir, spec)).href);
      const manifest = mod.default ?? mod;
      assert.ok(manifest?.id, `bundle chunk ${spec} did not export an extension manifest`);
      ids.add(manifest.id);
    }

    assert.deepEqual([...ids].sort(), ["intentions", "notes", "pages"]);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});
