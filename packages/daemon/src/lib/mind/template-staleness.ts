import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { resolve } from "node:path";
import {
  composeTemplate,
  findTemplatesRoot,
  listFiles,
  type TemplateManifest,
} from "../template/template.js";
import { computeTemplateHash } from "../template/template-hash.js";
import log from "../util/logger.js";
import { type MindEntry, mindDir } from "./registry.js";

type TemplateFileList = {
  files: string[];
  manifest: TemplateManifest;
  contents: Map<string, Buffer>;
};

const fileListCache = new Map<string, TemplateFileList>();

/**
 * The list of composed template files (excluding .init/), their contents, and
 * the manifest, memoized per template name. This mirrors the file selection in
 * computeTemplateHash() so the two hashes are directly comparable.
 */
function getTemplateFileList(templateName: string): TemplateFileList {
  const cached = fileListCache.get(templateName);
  if (cached) return cached;

  const templatesRoot = findTemplatesRoot();
  const baseDir = resolve(templatesRoot, "_base");
  const templateDir = resolve(templatesRoot, templateName);
  if (!existsSync(baseDir)) throw new Error(`Base template not found: ${baseDir}`);
  if (!existsSync(templateDir)) throw new Error(`Template not found: ${templateName}`);

  const { composedDir, manifest } = composeTemplate(templatesRoot, templateName);
  try {
    const files = listFiles(composedDir)
      .filter((f) => !f.startsWith(".init/") && !f.startsWith(".init\\"))
      .sort();
    const contents = new Map<string, Buffer>();
    for (const file of files) {
      contents.set(file, readFileSync(resolve(composedDir, file)));
    }
    const result: TemplateFileList = { files, manifest, contents };
    fileListCache.set(templateName, result);
    return result;
  } finally {
    rmSync(composedDir, { recursive: true, force: true });
  }
}

/**
 * Hash a mind's actual on-disk template files, using the same file list and
 * algorithm as computeTemplateHash(), so a pristine mind hashes identically to
 * computeTemplateHash(templateName). Renames from the manifest are applied
 * (composed `gitignore` maps to on-disk `.gitignore`).
 *
 * For files that carry a `{{name}}` substitution, the expected on-disk bytes are
 * derived by forward-substituting the mind name into the composed template — the
 * same transform copyTemplateToDir() applies at creation — and compared to the
 * actual file. A pristine file contributes the canonical `{{name}}` form (so the
 * total lines up with computeTemplateHash), a drifted file contributes its own
 * on-disk bytes (guaranteeing a mismatch). This avoids reverse-substituting the
 * mind name, which over-replaces when the name is a substring of file content
 * (e.g. a mind named "dev" colliding with package.json's "devDependencies").
 *
 * Missing files hash as absent, producing a mismatch rather than a false match.
 */
export function computeMindTemplateHash(
  mindProjectDir: string,
  templateName: string,
  mindName: string,
): string {
  const { files, manifest, contents } = getTemplateFileList(templateName);
  const substituteSet = new Set(manifest.substitute);

  const hash = createHash("sha256");
  for (const file of files) {
    const onDiskRel = manifest.rename[file] ?? file;
    const onDiskPath = resolve(mindProjectDir, onDiskRel);
    hash.update(file);
    hash.update("\0");

    if (!existsSync(onDiskPath)) {
      hash.update("\0__ABSENT__\0");
      continue;
    }

    const composed = contents.get(file) as Buffer;
    const onDisk = readFileSync(onDiskPath);

    if (substituteSet.has(onDiskRel) && mindName.length > 0) {
      const expected = Buffer.from(
        composed.toString("utf-8").replaceAll("{{name}}", mindName),
        "utf-8",
      );
      hash.update(onDisk.equals(expected) ? composed : onDisk);
    } else {
      hash.update(onDisk);
    }
  }
  return hash.digest("hex");
}

/**
 * A cheap directory-wide change signal over the mind's tracked template files:
 * the max mtime of the files that exist, plus how many exist. Any edit (mtime
 * rises), removal (count drops), or re-addition (count rises) of a tracked file
 * changes the signal, so the staleness memo below is invalidated when *any*
 * template-owned file drifts — not just the sentinel.
 */
function trackedSignal(mindProjectDir: string, templateName: string): string {
  const { files, manifest } = getTemplateFileList(templateName);
  let maxMtime = 0;
  let present = 0;
  for (const file of files) {
    const onDiskRel = manifest.rename[file] ?? file;
    try {
      const m = statSync(resolve(mindProjectDir, onDiskRel)).mtimeMs;
      present++;
      if (m > maxMtime) maxMtime = m;
    } catch {
      // Missing file — reflected by the lower `present` count.
    }
  }
  return `${maxMtime}:${present}`;
}

type StaleCacheEntry = { signal: string; stale: boolean };
const staleCache = new Map<string, StaleCacheEntry>();
const warnedTemplates = new Set<string>();

/**
 * Whether a mind is running an out-of-date copy of its template's framework
 * code. Only regular minds carry a per-mind template copy that can drift;
 * spirits (they sync via syncSpiritTemplate on restart), seeds, and variants
 * (which share the parent's worktree) are never reported stale.
 *
 * The measurement is truthful: it hashes the mind's actual on-disk files rather
 * than trusting the stored `template_hash`. The stored hash is used only as a
 * fast path — when it already matches the current template we skip the disk
 * read. A mismatch, a null hash, or an unreadable mind dir all read as stale.
 *
 * Results are memoized per mind dir keyed on a directory-wide change signal over
 * the tracked files, so `volute mind list` doesn't re-hash every mind on each
 * call yet still notices drift in any template-owned file.
 */
export function isTemplateStale(entry: MindEntry): boolean {
  if (entry.mindType !== "mind") return false;
  if (entry.stage === "seed") return false;
  if (entry.parent) return false;

  const templateName = entry.template ?? "claude";
  let current: string;
  try {
    current = computeTemplateHash(templateName);
  } catch (err) {
    // Can't resolve/build the template — surface it once so a broken template
    // doesn't silently disable the staleness check for every mind.
    if (!warnedTemplates.has(templateName)) {
      warnedTemplates.add(templateName);
      log.warn(
        `cannot compute template hash for '${templateName}'; skipping staleness check`,
        log.errorData(err),
      );
    }
    return false;
  }

  // Fast path: the last hash we wrote already matches the current template.
  if (entry.templateHash != null && entry.templateHash === current) return false;

  const dir = mindDir(entry.name);
  const signal = trackedSignal(dir, templateName);

  const cached = staleCache.get(dir);
  if (cached && cached.signal === signal) return cached.stale;

  let stale: boolean;
  try {
    stale = computeMindTemplateHash(dir, templateName, entry.name) !== current;
  } catch {
    // Can't read the mind's on-disk template — treat unknown as stale.
    stale = true;
  }
  staleCache.set(dir, { signal, stale });
  return stale;
}
