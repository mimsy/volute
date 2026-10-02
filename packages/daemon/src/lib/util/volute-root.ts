import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Volute's package root and its parsed package.json, recognised by name, since the
 * workspace package this file lives in has one of its own (#1249). The files that ship
 * beside it (package.json, CHANGELOG.md) are read from here and nowhere else, so an
 * unrelated file further up is never mistaken for Volute's (#1314).
 * In built dist (flat with splitting): dist/chunk-*.js → ..
 * In dev via tsx: packages/daemon/src/lib/util/volute-root.ts → ../../../../..
 */
export function voluteManifest(
  fromDir: string = import.meta.dirname,
): { root: string; version: string } | null {
  for (const root of [resolve(fromDir, ".."), resolve(fromDir, "../../../../..")]) {
    try {
      const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf-8"));
      if (pkg.name === "volute") return { root, version: pkg.version };
    } catch {}
  }
  return null;
}

/**
 * Volute's package root — the one directory its bundled assets (templates/, skills/,
 * dist/connectors/, dist/web-assets/, packages/extensions/*) are looked up under — or
 * null when it can't be identified. Asset lookups go through here rather than walking
 * up from their own module, so an unrelated directory above the install never answers
 * (#1336).
 */
export function voluteRoot(): string | null {
  return voluteManifest()?.root ?? null;
}
