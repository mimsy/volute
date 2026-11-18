import { resolve } from "node:path";
import { voluteRoot } from "./util/volute-root.js";

/**
 * The extensions this Volute ships built in. `discoverBuiltinExtensions` loads exactly these
 * (test/extension-bundle.test.ts pins the two together).
 */
export const BUILTIN_EXTENSION_IDS: readonly string[] = ["pages", "intentions", "feedback"];

/**
 * Where a built-in extension's skills ship under Volute's root — on disk whether the
 * extension loaded, failed to, or is disabled — or null when the root can't be identified.
 */
export function builtinExtensionSkillsDir(id: string): string | null {
  const root = voluteRoot();
  return root ? resolve(root, "packages", "extensions", id, "skills") : null;
}
