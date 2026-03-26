import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { composeTemplate, findTemplatesRoot, listFiles } from "./template.js";

const hashCache = new Map<string, string>();

/**
 * Compute a deterministic SHA-256 hash of a composed template (excluding .init/ files).
 * Results are memoized per template name since templates don't change at runtime.
 */
export function computeTemplateHash(templateName: string): string {
  const cached = hashCache.get(templateName);
  if (cached) return cached;

  // Pre-validate to avoid process.exit() paths in composeTemplate/findTemplatesRoot
  const templatesRoot = findTemplatesRoot();
  const baseDir = resolve(templatesRoot, "_base");
  const templateDir = resolve(templatesRoot, templateName);
  if (!existsSync(baseDir)) throw new Error(`Base template not found: ${baseDir}`);
  if (!existsSync(templateDir)) throw new Error(`Template not found: ${templateName}`);

  const { composedDir } = composeTemplate(templatesRoot, templateName);

  try {
    const files = listFiles(composedDir)
      .filter((f) => !f.startsWith(".init/") && !f.startsWith(".init\\"))
      .sort();

    const hash = createHash("sha256");
    for (const file of files) {
      const content = readFileSync(resolve(composedDir, file));
      hash.update(file);
      hash.update("\0");
      hash.update(content);
    }

    const result = hash.digest("hex");
    hashCache.set(templateName, result);
    return result;
  } finally {
    rmSync(composedDir, { recursive: true, force: true });
  }
}
