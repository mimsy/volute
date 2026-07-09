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
import { type MindEntry, mindDir } from "./registry.js";

type TemplateFileList = { files: string[]; manifest: TemplateManifest };

const fileListCache = new Map<string, TemplateFileList>();

/**
 * The list of composed template files (excluding .init/) plus the manifest,
 * memoized per template name. This mirrors the file selection in
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
    const result: TemplateFileList = { files, manifest };
    fileListCache.set(templateName, result);
    return result;
  } finally {
    rmSync(composedDir, { recursive: true, force: true });
  }
}

/**
 * Hash a mind's actual on-disk template files, using the same file list and
 * algorithm as computeTemplateHash(). Renames from the manifest are reversed
 * (on-disk `package.json` maps back to composed `package.json.tmpl`) and the
 * `{{name}}` substitution applied at creation is undone, so a pristine mind
 * hashes identically to computeTemplateHash(templateName). Missing files hash
 * as absent, producing a mismatch rather than a false match.
 */
export function computeMindTemplateHash(
  mindProjectDir: string,
  templateName: string,
  mindName: string,
): string {
  const { files, manifest } = getTemplateFileList(templateName);
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

    let content: Buffer;
    if (substituteSet.has(onDiskRel) && mindName.length > 0) {
      // Reverse the {{name}} substitution so a pristine mind matches the
      // composed template (whose content still has the {{name}} placeholder).
      const text = readFileSync(onDiskPath, "utf-8").replaceAll(mindName, "{{name}}");
      content = Buffer.from(text, "utf-8");
    } else {
      content = readFileSync(onDiskPath);
    }
    hash.update(content);
  }
  return hash.digest("hex");
}

type StaleCacheEntry = { mtime: number; stale: boolean };
const staleCache = new Map<string, StaleCacheEntry>();

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
 * Results are memoized per mind dir keyed on the mtime of src/agent.ts, so
 * `volute mind list` doesn't re-hash every mind on each call.
 */
export function isTemplateStale(entry: MindEntry): boolean {
  if (entry.mindType !== "mind") return false;
  if (entry.stage === "seed") return false;
  if (entry.parent) return false;

  const templateName = entry.template ?? "claude";
  let current: string;
  try {
    current = computeTemplateHash(templateName);
  } catch {
    // Unknown/unbuildable template — can't assess, don't nag.
    return false;
  }

  // Fast path: the last hash we wrote already matches the current template.
  if (entry.templateHash != null && entry.templateHash === current) return false;

  const dir = mindDir(entry.name);
  const sentinel = resolve(dir, "src", "agent.ts");
  const mtime = existsSync(sentinel) ? statSync(sentinel).mtimeMs : 0;

  const cached = staleCache.get(dir);
  if (cached && cached.mtime === mtime) return cached.stale;

  let stale: boolean;
  try {
    stale = computeMindTemplateHash(dir, templateName, entry.name) !== current;
  } catch {
    // Can't read the mind's on-disk template — treat unknown as stale.
    stale = true;
  }
  staleCache.set(dir, { mtime, stale });
  return stale;
}
