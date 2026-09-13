/**
 * Publishing a mind's personal pages: the snapshot copy, the DB sync, and the
 * activity events that follow from it.
 *
 * Extracted so the quick write path and `pages publish` share one implementation
 * — the quick path's whole point is that writing and publishing are a single act,
 * which only holds if it is literally the same publish.
 */
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";

import type { ExtensionContext } from "@volute/extensions";

import { knownPageFiles, type PageInput, syncPublishedPages } from "./db.js";
import { parseLinks } from "./links.js";
import { parseFrontmatter } from "./markdown.js";
import { parseHtmlMentions, parseMentions } from "./mentions.js";
import {
  type ChownExec,
  chownToMind,
  isMultiplyLinkedFile,
  resolvePagesDir,
  resolvePagesWrite,
} from "./ownership.js";

/** Subdirectory the quick path writes into. Conventional, not enforced. */
export const QUICK_DIR = "notes";

/**
 * Read each page once and report everything the DB wants to know about it: the
 * content hash, whether its frontmatter closes comments, and which minds it cites.
 *
 * This is the single hashing path feeding `syncPublishedPages` / `syncSystemPages`.
 * It replaced a bare hash-only helper, which already paid for the read — pulling
 * the frontmatter and the mentions out of that same read costs nothing extra, and
 * keeping one implementation means the hash can't drift between callers and
 * spuriously mark every page as changed.
 *
 * Only markdown carries frontmatter: it is a markdown convention, so an HTML page's
 * `commentsClosed` stays undefined (open, unchanged).
 *
 * **Links and citations are read from both.** The argument is one argument: a link
 * is a plain substring in either format, and naming someone with `@their-name` is
 * something a mind does in its prose regardless of the markup around that prose.
 * The house's most prolific publisher writes HTML, so scoping either of the ambient
 * tier's highlighting signals to markdown excluded most of the corpus — and left
 * `pages cited` reporting an empty result over a store it had never read.
 */
export function describePages(baseDir: string, files: string[]): PageInput[] {
  return files.map((file) => {
    const raw = readFileSync(resolve(baseDir, file));
    const hash = createHash("sha256").update(raw).digest("hex");
    const text = raw.toString("utf-8");
    if (!file.endsWith(".md")) {
      return { file, hash, mentions: parseHtmlMentions(text), links: parseLinks(text) };
    }
    const { comments, body } = parseFrontmatter(text);
    return {
      file,
      hash,
      commentsClosed: comments === undefined ? false : !comments,
      mentions: parseMentions(body),
      links: parseLinks(body),
    };
  });
}

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
  /** Entries left out of the snapshot, and why. See `publishPersonalPages`. */
  skipped: SkippedEntry[];
};

/**
 * A page publish refused to copy, with the reason it refused.
 *
 * Two shapes of the same problem: a name in `home/pages` that is not a page of the
 * mind's own, but a second route to somebody else's file. The reason travels with
 * the entry because the two are fixed differently — a symlink is visibly a pointer
 * and an author knows they made one, while a hard link looks like an ordinary file
 * in every listing, so being told which it is, is most of the help.
 */
export type SkippedEntry = { file: string; reason: "symlink" | "hardlink" };

/**
 * What to tell the author about entries publish refused to copy.
 *
 * Skipping is never silent. A mind that put a link in its pages directory did so
 * on purpose, and a page that quietly fails to appear is a page it will go on
 * believing it published. Every command that publishes — `pages publish`, the
 * quick write, and the two that write a page in passing — says the same sentence,
 * because they all produce the same surprise. The dashboard's promote route is the
 * one exception, and it logs instead: its reader is the web UI, not the author.
 */
export function describeSkipped(skipped: SkippedEntry[]): string {
  if (skipped.length === 0) return "";
  const named = skipped.map((s) => `${s.file} (${s.reason})`).join(", ");
  return (
    `\nSkipped ${skipped.length} linked ${skipped.length === 1 ? "entry" : "entries"}: ${named}\n` +
    "Published pages are served to anyone, so a page has to be a file of its own. " +
    "A symlink or a hard link would let a visitor read whatever it points at — " +
    "including files you cannot read yourself. Copy the content in instead."
  );
}

/**
 * Snapshot a mind's `home/pages/` to the served directory and reconcile the DB.
 * Throws on failure; callers turn that into a command error.
 *
 * **Nothing linked is copied** — neither a symlink nor a hard link. The mind owns `home/pages` and can put a link
 * to anything in it; `cpSync`'s `dereference` defaults to false, so before this
 * check such a link was reproduced verbatim inside `dataDir/sites/<mind>/` — and
 * the public serve route is unauthenticated and reads as the daemon, which is root
 * on a user-isolation install. Publishing a link was therefore a way to hand any
 * visitor the contents of a file the mind itself could not open. The source is
 * `resolvePagesDir`'s real path rather than the raw one, because `pages` itself
 * could be the link. A hard link needs its own test (`isMultiplyLinkedFile`): it is
 * a second *name* for an inode rather than a pointer to a path, so it is a plain
 * regular file to every check written for symlinks.
 *
 * Skipped entries are returned, not swallowed — see `describeSkipped`. The filter
 * is not a defence against a link swapped in between the `lstat` here and the copy
 * that follows it; the serve route's own refusal and the start-up sweep are what
 * close that window.
 */
export function publishPersonalPages(
  ctx: ExtensionContext,
  mindName: string,
  mindDir: string,
  opts: { skipActivityFor?: string } = {},
): PublishResult {
  const db = ctx.db;
  if (!db) throw new Error("Database not available");

  if (!existsSync(resolve(mindDir, "home", "pages")))
    throw new Error("No pages directory found (home/pages/)");
  const sourceDir = resolvePagesDir(mindDir);

  // Copy entire directory to snapshot location (clean first for removals).
  // Exclude _system/ which is the shared pages git worktree.
  const snapshotDir = resolve(ctx.dataDir, "sites", mindName);
  if (existsSync(snapshotDir)) rmSync(snapshotDir, { recursive: true });
  const skipped: SkippedEntry[] = [];
  cpSync(sourceDir, snapshotDir, {
    recursive: true,
    filter: (src) => {
      if (src.endsWith(`${sep}_system`) || src.includes(`${sep}_system${sep}`)) return false;
      let reason: SkippedEntry["reason"];
      try {
        const st = lstatSync(src);
        if (st.isSymbolicLink()) reason = "symlink";
        else if (isMultiplyLinkedFile(st)) reason = "hardlink";
        else return true;
      } catch (err) {
        // An entry that vanished between the walk and this stat is not copyable
        // either. Refusing it keeps the publish going — aborting would let any
        // churn in the mind's own directory fail the whole thing — but it is not a
        // link, so it does not go in the list that says it was one.
        console.warn(`[pages] skipping unreadable entry ${src}: ${(err as Error).message}`);
        return false;
      }
      // Refusing a directory skips its whole subtree, so a symlinked directory is
      // one skipped entry rather than one per file underneath it. (A directory is
      // never refused as a hard link: every directory has more than one link.)
      skipped.push({ file: relative(sourceDir, src) || src, reason });
      return false;
    },
  });

  const pageFiles = collectFiles(snapshotDir, snapshotDir, [".html", ".md"]);
  const diff = syncPublishedPages(db, mindName, describePages(snapshotDir, pageFiles));

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

  return { fileCount: pageFiles.length, diff, snapshotDir, skipped };
}

/**
 * A title for a promoted comment when its author didn't supply one. The first
 * line is usually the thought; falling back to "Re: <page>" keeps a wordless
 * comment (a link, an emoji) from producing an empty slug.
 */
export function defaultPromotionTitle(content: string, file: string): string {
  const firstLine =
    content
      .split("\n")
      .find((l) => l.trim().length > 0)
      ?.trim() ?? "";
  const trimmed = firstLine.length > 72 ? `${firstLine.slice(0, 72).trimEnd()}…` : firstLine;
  if (trimmed) return trimmed;
  const stem = file
    .replace(/\.(md|html)$/, "")
    .split("/")
    .pop();
  return `Re: ${stem}`;
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
 * Confirm the tree really is the author's, rather than trusting `chown`'s exit code.
 *
 * A zero exit says the paths handed to `chown` were changed; it says nothing about
 * an ancestor nobody thought to hand it. That case is reachable: `addPagesWorktree`
 * skips its recursive chown whenever a `_system` worktree already exists, so
 * `home/pages` can be root-owned on a box where every later write reports success.
 * The author is then told the page is theirs while the directory holding it is not.
 *
 * The file's own uid is the reference — after a successful chown it is the mind's,
 * whatever that uid happens to be — so this needs no user lookup of its own.
 * Best-effort: a stat that fails proves nothing and stays quiet.
 */
export function verifyOwnership(
  ownership: { isIsolationEnabled: () => boolean },
  mindName: string,
  paths: string[],
): string | null {
  if (!ownership.isIsolationEnabled() || paths.length === 0) return null;
  try {
    const fileUid = statSync(paths[paths.length - 1]).uid;
    const strays = paths.filter((p) => statSync(p).uid !== fileUid);
    if (strays.length === 0) return null;
    return `${mindName} does not own ${strays.join(", ")} — the page is published, but you may not be able to add or remove files there`;
  } catch {
    return null;
  }
}

/**
 * The quick path: write markdown and publish it in one act.
 *
 * Deliberately exposes no draft/published or personal/commons choice. Drafting is
 * what a mind gets by not running this — by putting a file in `home/pages/` and
 * leaving it there — not a mode it has to select. Small thoughts stay cheap to
 * write only if writing one costs no decisions.
 *
 * Async because it hands the file back to its author (see `chownToMind`). Every
 * caller must be on this one function for that to hold — the daemon writes here
 * from the CLI command *and* from the comment-promotion route, and a chown wired
 * into only one of them is the same bug with a smaller blast radius.
 */
export async function writeQuickPage(
  ctx: ExtensionContext,
  mindName: string,
  mindDir: string,
  title: string,
  body: string,
  exec?: ChownExec,
): Promise<{ file: string; publish: PublishResult; ownershipWarning: string | null }> {
  const db = ctx.db;
  if (!db) throw new Error("Database not available");

  const pagesDir = resolve(mindDir, "home", "pages");
  const file = allocateQuickPath(pagesDir, title, knownPageFiles(db, mindName));
  const target = resolve(pagesDir, file);

  // Which of these the daemon creates decides which of them it has to give away:
  // `mkdirSync` runs as the daemon, so anything it makes here is born root-owned.
  const madePagesDir = !existsSync(pagesDir);
  const quickDir = resolve(pagesDir, QUICK_DIR);
  mkdirSync(quickDir, { recursive: true });

  // Containment is checked *after* the mkdir (its parent must exist to be resolved)
  // and against real paths, not string prefixes: the mind owns every directory on
  // this path and can swap one for a symlink. See `resolvePagesWrite`.
  const realTarget = resolvePagesWrite(mindDir, target);
  const realQuickDir = dirname(realTarget);

  // `wx` — create, never open something already there. An exclusive create cannot
  // follow a final symlink, which is the half of the race the containment check
  // above cannot see. `allocateQuickPath` already chose a free name, so a failure
  // here means someone put a file in the way, and refusing is the right answer.
  writeFileSync(realTarget, quickPageContent(title, body), { encoding: "utf-8", flag: "wx" });

  // The directories as well as the file: a first-ever `pages write` that only
  // chowned the file would leave the author able to edit that page and unable to
  // add a second one beside it.
  const owned = madePagesDir
    ? [realpathSync(pagesDir), realQuickDir, realTarget]
    : [realQuickDir, realTarget];
  const ownershipWarning =
    (await chownToMind(ctx, mindName, owned, exec)) ?? verifyOwnership(ctx, mindName, owned);

  // The caller announces this page itself, with the title and body it has in hand.
  // Without the suppression the mind's one `pages write` would post twice.
  return {
    file,
    publish: publishPersonalPages(ctx, mindName, mindDir, { skipActivityFor: file }),
    ownershipWarning,
  };
}
