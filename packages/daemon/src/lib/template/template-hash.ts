import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import {
  composeTemplate,
  findTemplatesRoot,
  isInitInfrastructure,
  listFiles,
  SHIPPED_HASHES_REL,
} from "./template.js";

const hashCache = new Map<string, string>();
const infraHashCache = new Map<string, string>();

/**
 * Compute a deterministic SHA-256 hash of a composed template (excluding .init/ files).
 * Results are memoized per template name since templates don't change at runtime.
 */
export function computeTemplateHash(templateName: string): string {
  const cached = hashCache.get(templateName);
  if (cached) return cached;

  // Pre-validate for clearer errors than composeTemplate/findTemplatesRoot's generic throws
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

/**
 * Hash the `.init/` infrastructure a template would give a mind: every `.init/.local/**`
 * file in `composedDir`, plus the shipped-hash ledger bytes.
 *
 * The ledger is folded in because it decides what the backfill *refreshes*: a release
 * that only records an older shipped version of a hook makes a mind's copy refreshable
 * without changing any file a mind would receive. Identity files under `.init/` are never
 * read — they are the mind's, and nothing here may ever act on them.
 */
export function hashInfrastructure(composedDir: string, shippedLedger: Buffer | null): string {
  const initDir = resolve(composedDir, ".init");
  const files = existsSync(initDir)
    ? listFiles(initDir)
        .map((f) => f.split(sep).join("/"))
        .filter(isInitInfrastructure)
        .sort()
    : [];

  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file);
    // The exec bit is part of what ships (`.local/bin/volute` is useless without it),
    // so a mode-only change reaches existing minds like a content change does (#1274).
    const path = resolve(initDir, file);
    hash.update(statSync(path).mode & 0o111 ? "\0x\0" : "\0");
    hash.update(readFileSync(path));
  }
  hash.update("\0SHIPPED\0");
  if (shippedLedger) hash.update(shippedLedger);
  return hash.digest("hex");
}

/**
 * Hash of a template's `.init/.local/` infrastructure (see {@link hashInfrastructure}).
 *
 * Deliberately separate from {@link computeTemplateHash}, which excludes `.init/`
 * entirely: folding hooks into that hash would mark every mind stale — and run a full
 * template merge on every auto-upgrading one — the day any hook changed. This hash
 * drives only the infrastructure backfill (`lib/mind/infrastructure-sync.ts`), so a
 * hook-only release still reaches every mind without touching anything else (#960).
 * Memoized per template name since templates don't change at runtime.
 */
export function computeInfrastructureHash(templateName: string): string {
  const cached = infraHashCache.get(templateName);
  if (cached) return cached;

  const templatesRoot = findTemplatesRoot();
  if (!existsSync(resolve(templatesRoot, templateName))) {
    throw new Error(`Template not found: ${templateName}`);
  }
  const ledgerPath = resolve(templatesRoot, "_base", SHIPPED_HASHES_REL);
  const ledger = existsSync(ledgerPath) ? readFileSync(ledgerPath) : null;

  const { composedDir } = composeTemplate(templatesRoot, templateName);
  try {
    const result = hashInfrastructure(composedDir, ledger);
    infraHashCache.set(templateName, result);
    return result;
  } finally {
    rmSync(composedDir, { recursive: true, force: true });
  }
}
