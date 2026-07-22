/**
 * Publishing a mind's personal pages: the snapshot copy, the DB sync, and the
 * activity events that follow from it.
 *
 * Extracted so the quick write path and `pages publish` share one implementation
 * — the quick path's whole point is that writing and publishing are a single act,
 * which only holds if it is literally the same publish.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { relative, resolve, sep } from "node:path";

import type { ExtensionContext } from "@volute/extensions";

import { knownPageFiles, syncPublishedPages } from "./db.js";
import { hashFiles } from "./shared-pages.js";

/** Subdirectory the quick path writes into. Conventional, not enforced. */
export const QUICK_DIR = "notes";

/** Recursively collect files, returning paths relative to baseDir. Optionally filter by extension(s). */
export function collectFiles(dir: string, baseDir: string, ext?: string | string[]): string[] {
  const files: string[] = [];
  let items: string[];
  try {
    items = readdirSync(dir);
  } catch (err) {
    console.error(`[pages] failed to read directory ${dir}: ${(err as Error).message}`);
    return files;
  }

  for (const item of items) {
    if (item.startsWith(".")) continue;
    const fullPath = resolve(dir, item);
    try {
      const s = statSync(fullPath);
      const matchesExt =
        !ext || (Array.isArray(ext) ? ext.some((e) => item.endsWith(e)) : item.endsWith(ext));
      if (s.isFile() && matchesExt) {
        files.push(relative(baseDir, fullPath));
      } else if (s.isDirectory()) {
        files.push(...collectFiles(fullPath, baseDir, ext));
      }
    } catch (err) {
      console.error(`[pages] failed to stat ${fullPath}: ${(err as Error).message}`);
    }
  }

  return files.sort();
}

export type PublishResult = {
  fileCount: number;
  diff: { added: string[]; removed: string[]; updated: string[] };
  snapshotDir: string;
};

/**
 * Snapshot a mind's `home/pages/` to the served directory and reconcile the DB.
 * Throws on failure; callers turn that into a command error.
 */
export function publishPersonalPages(
  ctx: ExtensionContext,
  mindName: string,
  mindDir: string,
  opts: { skipActivityFor?: string } = {},
): PublishResult {
  const db = ctx.db;
  if (!db) throw new Error("Database not available");

  const sourceDir = resolve(mindDir, "home", "pages");
  if (!existsSync(sourceDir)) throw new Error("No pages directory found (home/pages/)");

  // Copy entire directory to snapshot location (clean first for removals).
  // Exclude _system/ which is the shared pages git worktree.
  const snapshotDir = resolve(ctx.dataDir, "sites", mindName);
  if (existsSync(snapshotDir)) rmSync(snapshotDir, { recursive: true });
  cpSync(sourceDir, snapshotDir, {
    recursive: true,
    filter: (src) => !src.endsWith(`${sep}_system`) && !src.includes(`${sep}_system${sep}`),
  });

  const pageFiles = collectFiles(snapshotDir, snapshotDir, [".html", ".md"]);
  const diff = syncPublishedPages(db, mindName, hashFiles(snapshotDir, pageFiles));

  for (const file of diff.added) {
    if (file === opts.skipActivityFor) continue;
    ctx.publishActivity({
      type: "page_published",
      mind: mindName,
      summary: `${mindName} published ${file}`,
      metadata: {
        file,
        url: `/minds/${mindName}/pages/${file}`,
        iframeUrl: `/ext/pages/public/${mindName}/${file}`,
      },
    });
  }
  for (const file of diff.removed) {
    ctx.publishActivity({
      type: "page_removed",
      mind: mindName,
      summary: `${mindName} removed ${file}`,
      metadata: { file },
    });
  }

  return { fileCount: pageFiles.length, diff, snapshotDir };
}

/** Turn a title into a URL-safe slug. */
export function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      // Drop apostrophes so "Skeleton's" → "skeletons", not "skeleton-s".
      .replace(/['’]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
  );
}

/** Escape a value for a YAML double-quoted scalar. */
function yamlQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Render the markdown file the quick path writes. */
export function quickPageContent(title: string, body: string): string {
  return `---\ntitle: ${yamlQuote(title)}\n---\n\n${body.trimEnd()}\n`;
}

/**
 * Choose a free `notes/<slug>.md` under the mind's pages directory. Suffixes on
 * collision rather than overwriting: a mind writing two things with the same
 * title has written two things.
 *
 * `taken` carries page identities the DB already knows about — crucially including
 * tombstones. A deleted page keeps its row so its thread survives, so re-using its
 * address would revive that row and graft a stranger's conversation onto brand-new,
 * unrelated writing. An address that has ever been spoken for is not free.
 */
export function allocateQuickPath(pagesDir: string, title: string, taken?: Set<string>): string {
  const base = slugify(title) || "untitled";
  const dir = resolve(pagesDir, QUICK_DIR);
  const isFree = (name: string) =>
    !existsSync(resolve(dir, name)) && !taken?.has(`${QUICK_DIR}/${name}`);
  let name = `${base}.md`;
  for (let i = 2; !isFree(name); i++) {
    name = `${base}-${i}.md`;
  }
  return `${QUICK_DIR}/${name}`;
}

/**
 * The quick path: write markdown and publish it in one act.
 *
 * Deliberately exposes no draft/published or personal/commons choice. Drafting is
 * what a mind gets by not running this — by putting a file in `home/pages/` and
 * leaving it there — not a mode it has to select. Small thoughts stay cheap to
 * write only if writing one costs no decisions.
 */
export function writeQuickPage(
  ctx: ExtensionContext,
  mindName: string,
  mindDir: string,
  title: string,
  body: string,
): { file: string; publish: PublishResult } {
  const db = ctx.db;
  if (!db) throw new Error("Database not available");

  const pagesDir = resolve(mindDir, "home", "pages");
  const file = allocateQuickPath(pagesDir, title, knownPageFiles(db, mindName));
  const target = resolve(pagesDir, file);

  // The slug is derived from the title and stripped to [a-z0-9-], so it cannot
  // contain a separator — but assert containment anyway rather than trusting the
  // sanitizer to stay correct as it changes.
  const root = resolve(pagesDir);
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error("Refusing to write outside the pages directory");
  }

  mkdirSync(resolve(pagesDir, QUICK_DIR), { recursive: true });
  writeFileSync(target, quickPageContent(title, body), "utf-8");

  // The caller announces this page itself, with the title and body it has in hand.
  // Without the suppression the mind's one `pages write` would post twice.
  return { file, publish: publishPersonalPages(ctx, mindName, mindDir, { skipActivityFor: file }) };
}
