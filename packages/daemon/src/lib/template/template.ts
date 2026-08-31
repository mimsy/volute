import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { readInitLedger, writeInitLedger } from "../mind/init-ledger.js";

export type TemplateManifest = {
  rename: Record<string, string>;
  substitute: string[];
};

/**
 * Merge a template's manifest over `_base`'s. `_base` ships the shared manifest
 * (the union of everything every template needs); a per-template manifest exists
 * only to declare genuine differences — of which there are currently none, so all
 * three ship `{}`.
 *
 * - `substitute`: union of base + template entries (dedup, base order first). A
 *   path only has to be declared once, in `_base`, and every template inherits it.
 *   This is the single-source-of-truth that #789 restores: before it, all three
 *   manifests repeated the same list and all three carried the same wrong path
 *   (`home/.config/routes.json`), leaving `{{name}}` in every mind's routes.json.
 * - `rename`: template entries override base on key collision.
 */
export function mergeManifests(
  base: Partial<TemplateManifest>,
  template: Partial<TemplateManifest>,
): TemplateManifest {
  return {
    rename: { ...base.rename, ...template.rename },
    substitute: [...new Set([...(base.substitute ?? []), ...(template.substitute ?? [])])],
  };
}

/**
 * Find the templates root directory by walking up from the calling module's location.
 * Returns the parent `templates/` directory (not a specific template).
 */
let _templatesRoot: string | null = null;

/**
 * Locate the templates root, returning null instead of exiting when it isn't
 * found. Callers running inside the long-lived daemon must use this: the
 * `process.exit(1)` in {@link findTemplatesRoot} is appropriate for one-shot CLI
 * use but would take down every mind on the host, and no try/catch can stop it.
 */
export function locateTemplatesRoot(): string | null {
  if (_templatesRoot) return _templatesRoot;
  let dir = dirname(new URL(import.meta.url).pathname);
  for (let i = 0; i < 7; i++) {
    const candidate = resolve(dir, "templates");
    if (existsSync(resolve(candidate, "_base"))) {
      _templatesRoot = candidate;
      return _templatesRoot;
    }
    dir = dirname(dir);
  }
  return null;
}

export function findTemplatesRoot(): string {
  const root = locateTemplatesRoot();
  if (root) return root;
  // Throw rather than exit: every caller runs inside the long-lived daemon (create,
  // import, upgrade, staleness, spirit sync), where a process.exit(1) would take down
  // every mind, bridge, and the web server that no try/catch could stop. Route handlers
  // catch this and return 500.
  throw new Error(
    `Templates directory not found. Searched up from: ${dirname(new URL(import.meta.url).pathname)}`,
  );
}

export function findTemplatesDir(template: string): string {
  const root = findTemplatesRoot();
  const dir = resolve(root, template);
  if (!existsSync(dir)) {
    throw new Error(`Template not found: ${template}`);
  }
  return dir;
}

/**
 * Compose a template by layering _base + template-specific files into a temp directory.
 * Returns the composed dir path and parsed manifest.
 */
export function composeTemplate(
  templatesRoot: string,
  templateName: string,
): { composedDir: string; manifest: TemplateManifest } {
  const baseDir = resolve(templatesRoot, "_base");
  const templateDir = resolve(templatesRoot, templateName);

  if (!existsSync(baseDir)) {
    throw new Error(`Base template not found: ${baseDir}`);
  }
  if (!existsSync(templateDir)) {
    throw new Error(`Template not found: ${templateName}`);
  }

  // Create a unique temp staging directory. A timestamp suffix is not enough: two
  // concurrent compositions of the same template in the same millisecond would share
  // the dir, and one's cleanup rmSync yanks it out from under the other (test flake).
  const composedDir = mkdtempSync(resolve(tmpdir(), `volute-template-${templateName}-`));

  // Copy _base first
  cpSync(baseDir, composedDir, { recursive: true });

  // Overlay template-specific files (overwriting base files where they conflict)
  for (const file of listFiles(templateDir)) {
    const src = resolve(templateDir, file);
    const dest = resolve(composedDir, file);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(src, dest);
  }

  // Read manifest by merging the template's over _base's, rather than letting the
  // template's replace it. _base ships the shared manifest; a template's declares
  // only genuine differences (see mergeManifests). The two source files are read
  // directly — reading the composed copy would only ever see the template's, since
  // the file-overlay above already overwrote _base's with it.
  const baseManifestPath = resolve(baseDir, "volute-template.json");
  if (!existsSync(baseManifestPath)) {
    rmSync(composedDir, { recursive: true, force: true });
    throw new Error("Base template manifest not found: _base/volute-template.json");
  }
  const baseManifest = JSON.parse(
    readFileSync(baseManifestPath, "utf-8"),
  ) as Partial<TemplateManifest>;

  const templateManifestPath = resolve(templateDir, "volute-template.json");
  const templateManifest = existsSync(templateManifestPath)
    ? (JSON.parse(readFileSync(templateManifestPath, "utf-8")) as Partial<TemplateManifest>)
    : {};

  const manifest = mergeManifests(baseManifest, templateManifest);

  // Remove manifest from composed output (the template's overlaid copy).
  rmSync(resolve(composedDir, "volute-template.json"), { force: true });

  // Same for the shipped-hash ledger. It lives *inside* `.init/.local/` so that
  // the classification test sees it and a future `.local/` file can't be added
  // without someone deciding about it — but it is Volute's bookkeeping, not a
  // mind's file, and must never land in anyone's home/. Stripping it here is the
  // single exclusion point: copyTemplateToDir, applyInitFiles, and
  // backfillInitInfrastructure all read the composed tree, so none of them can
  // see it. The backfill reads the ledger from the source tree instead.
  rmSync(resolve(composedDir, SHIPPED_HASHES_REL), { force: true });

  return { composedDir, manifest };
}

/**
 * Copy a composed template to the destination directory with name substitution.
 *
 * `manifest.substitute` is the single source of truth for which files carry
 * `{{name}}`, and its paths are relative to the *composed* layout — so a file
 * that ships via `.init/` must be listed under its `.init/...` path, not the
 * `home/...` path it eventually lands at. Substitution runs here, before
 * applyInitFiles() overlays `.init/` onto `home/`; listing the `home/` path for
 * a file that `.init/` shadows substitutes a copy that is then overwritten
 * (which is how `@{{name}}` shipped verbatim in every mind's routes.json).
 */
export function copyTemplateToDir(
  composedDir: string,
  destDir: string,
  mindName: string,
  manifest: TemplateManifest,
) {
  cpSync(composedDir, destDir, { recursive: true });

  // Rename files per manifest
  for (const [from, to] of Object.entries(manifest.rename)) {
    const fromPath = resolve(destDir, from);
    if (existsSync(fromPath)) {
      renameSync(fromPath, resolve(destDir, to));
    }
  }

  // Replace {{name}} placeholders in specified files
  for (const file of manifest.substitute) {
    const path = resolve(destDir, file);
    if (existsSync(path)) {
      const content = readFileSync(path, "utf-8");
      writeFileSync(path, content.replaceAll("{{name}}", mindName));
    }
  }
}

/**
 * Substitute {{name}} in the composed template's package.json.
 *
 * composeTemplate() leaves package.json under its real name but with the
 * {{name}} placeholder unsubstituted — the substitution normally happens in
 * copyTemplateToDir(). Callers that read composedDir/package.json directly (e.g.
 * syncSpiritTemplate) must render it first, otherwise a template switch silently
 * skips updating deps / npm install. Idempotent (replaceAll on an already-
 * substituted file is a no-op); returns the package.json path, or null if the
 * template ships no package.json.
 */
export function renderComposedPackageJson(composedDir: string, mindName: string): string | null {
  const dest = resolve(composedDir, "package.json");
  if (!existsSync(dest)) return null;
  const content = readFileSync(dest, "utf-8").replaceAll("{{name}}", mindName);
  writeFileSync(dest, content);
  return dest;
}

/**
 * Copy .init/ files into home/ and remove .init/.
 * Called during mind creation (not during upgrades).
 *
 * Returns the `.init/`-relative paths of the *infrastructure* files it applied
 * (see {@link INIT_INFRASTRUCTURE_PREFIXES}), for `seedInitLedger` to record as
 * this mind's starting set. Filtering here rather than at each creation call
 * site means a caller cannot forget it and record identity files as
 * framework-given.
 */
export function applyInitFiles(destDir: string): string[] {
  const initDir = resolve(destDir, ".init");
  if (!existsSync(initDir)) return [];

  const homeDir = resolve(destDir, "home");
  const infrastructure: string[] = [];
  for (const file of listFiles(initDir)) {
    const src = resolve(initDir, file);
    const dest = resolve(homeDir, file);
    const parent = dirname(dest);
    if (!existsSync(parent)) {
      mkdirSync(parent, { recursive: true });
    }
    cpSync(src, dest);
    const rel = file.split(sep).join("/");
    if (isInitInfrastructure(rel)) infrastructure.push(rel);
  }

  rmSync(initDir, { recursive: true, force: true });
  return infrastructure;
}

/**
 * The `.init/` subtrees that hold *infrastructure* rather than *identity*.
 *
 * Every file under `.init/` is copied into `home/` once, at mind creation, and
 * upgrades deliberately never touch `.init/` again — that exclusion is what
 * keeps a mind's SOUL.md and MEMORY.md safe from the template. But `.init/`
 * carries two different kinds of thing, and the exclusion was blocking both.
 *
 * The property that separates them is authorship: **could this mind have
 * written it about itself?** SOUL.md, MEMORY.md, `memory/`, and `.config/` are
 * the mind's own — what it is, what it remembers, how it is wired. Re-adding
 * those would be the framework talking over the mind.
 *
 * `home/.local/` is the opposite: it is Volute's machinery namespace inside the
 * home directory. The daemon generates skill shims into `.local/bin/` and
 * executes `.local/hooks/<event>/` itself. Those are safe to *add*, and are
 * added by {@link backfillInitInfrastructure} on upgrade.
 *
 * "Add, never overwrite" still holds inside `.local/`: a mind may have edited
 * its own hook (the shipped ones invite exactly that in their header comments),
 * and that edit is authorship too.
 *
 * Deleting is authorship too, and absence on its own cannot say whose: "this
 * mind predates the hook" and "this mind removed it on purpose" look identical
 * on disk. The per-mind ledger in `lib/mind/init-ledger.ts` is what tells them
 * apart — it records every infrastructure path a mind has ever been given, so
 * *given and now absent* reads as a deliberate removal and is left alone,
 * while *never given and absent* is the #808 case and is added (#811). A mind
 * that removes a hook does not have to do it twice.
 *
 * This is a subtree rule, not a filename list, so a hook added under
 * `.local/hooks/` in future is covered the day it ships with no second edit
 * here. `test/template-init-classification.test.ts` pins the classification of
 * every `.init/` file the templates ship, so any newly shipped `.init/` file,
 * at any depth, fails the suite until someone classifies it on purpose.
 */
export const INIT_INFRASTRUCTURE_PREFIXES = [".local/"] as const;

/**
 * Where the shipped-hash ledger lives, relative to a composed template (and, in
 * the source tree, relative to `templates/_base/`).
 */
export const SHIPPED_HASHES_REL = ".init/.local/SHIPPED.json";

/** `.init/`-relative path -> sha256 of every version of that file Volute has ever shipped. */
export type ShippedHashes = Record<string, string[]>;

export function sha256(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Read the shipped-hash ledger: for each `.init/.local/` file, the sha256 of
 * every version of it Volute has ever shipped.
 *
 * This is what lets {@link backfillInitInfrastructure} tell "the mind is still
 * running an old copy of *our* file" from "the mind rewrote this hook". A hash
 * in the ledger means Volute wrote those exact bytes at some point, so replacing
 * them takes nothing the mind authored. A hash that isn't in the ledger is, as
 * far as we can tell, the mind's — and is never touched.
 *
 * Missing or unparseable ledger degrades to `{}`: every file becomes unknown,
 * and the backfill falls back to its old add-only behaviour rather than
 * refusing to run.
 */
export function readShippedHashes(templatesRoot: string): ShippedHashes {
  const path = resolve(templatesRoot, "_base", SHIPPED_HASHES_REL);
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as ShippedHashes;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** Whether a `.init/`-relative path is framework infrastructure (see {@link INIT_INFRASTRUCTURE_PREFIXES}). */
export function isInitInfrastructure(relPath: string): boolean {
  const normalized = relPath.split(sep).join("/");
  return INIT_INFRASTRUCTURE_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

/**
 * The infrastructure paths (`.init/`-relative) actually present under a `home/`.
 *
 * For creation paths that copy a whole mind tree rather than composing one from
 * the template — importing a full archive — this is what `applyInitFiles`'s
 * return value is for the composed paths: the set to seed the ledger with. It
 * matters because an archive faithfully carries an *absence*: a mind that
 * deleted a hook before it was exported should arrive on the new host still
 * having deleted it, rather than being handed it back on its first upgrade.
 */
export function listInfrastructureOnDisk(homeDir: string): string[] {
  const found: string[] = [];
  for (const prefix of INIT_INFRASTRUCTURE_PREFIXES) {
    const dir = resolve(homeDir, prefix);
    if (!existsSync(dir)) continue;
    for (const file of listFiles(dir)) {
      found.push(prefix + file.split(sep).join("/"));
    }
  }
  return found;
}

/**
 * Whether an infrastructure file already on disk may be replaced by the
 * template's current copy.
 *
 * The whole authorship judgement lives here: `true` only when the bytes on disk
 * are ones Volute itself wrote (some hash in the ledger) and are not already the
 * current ones. Everything else — a hash we don't recognise, an emptied file, a
 * path with no ledger entry, an unreadable ledger — is `false`, i.e. the mind's,
 * i.e. untouched.
 */
export function mayRefreshInfrastructure(
  onDisk: Buffer | string,
  fromTemplate: Buffer | string,
  shippedHashes: string[] | undefined,
): boolean {
  if (!shippedHashes?.length) return false;
  const current = sha256(onDisk);
  if (!shippedHashes.includes(current)) return false;
  return current !== sha256(fromTemplate);
}

/**
 * Copy `.init/` infrastructure files that are *missing* from a mind's `home/`.
 *
 * The upgrade-side counterpart to {@link applyInitFiles}. Without it, any
 * capability shipped as a new hook or shim reaches only minds created after it
 * existed, while the daemon-side half of the feature ships and looks healthy —
 * which is how every mind on the production host but the newest ended up unable
 * to read its own next-turn system events (#808).
 *
 * Three outcomes, and the difference is authorship:
 *
 * - **added** — the file is missing and this mind's ledger has never recorded
 *   it. It predates the hook. Copy it in.
 * - **refreshed** — the file is present and byte-identical to some version
 *   Volute has shipped (per `.init/.local/SHIPPED.json`), so the mind never
 *   edited it; it is just an old copy of our own file. Overwrite it.
 * - **withheld** — the file is missing but the ledger says we gave it to this
 *   mind. It was removed on purpose. Leave it gone (#811).
 *
 * Anything else is left exactly alone. A file whose hash we don't recognise is
 * the mind's work, and stays the mind's work — the same guarantee as before,
 * one step stronger, because "present" no longer has to stand in for "authored".
 *
 * `honorRemovals: false` turns the withholding off for one call, for the one
 * caller that knows an absence is *its own* fault rather than the mind's: an
 * upgrade whose restore of merge-deleted `home/` files threw partway. Reading
 * that damage as authorship would withhold the files permanently and silently,
 * which is the #808 failure shape again; re-adding a hook the mind meant to
 * delete costs it one more deletion, on a path the host is already being warned
 * about. The silent permanent loss is the worse of the two.
 *
 * The ledger is maintained here, uniformly, with no first-run migration branch:
 * every path observed present, and every path successfully installed, is
 * recorded. For a mind that predates the ledger that means its first run
 * derives one from disk — so a removal made *before* this shipped is undone
 * exactly once and then recorded, and the mind's second removal of the same
 * file is durable. That is the deliberate trade: seeding from the full shipped
 * set instead would honour those old removals, but would also permanently
 * withhold hooks from every mind that legitimately never had them, which is the
 * #808 bug it took a release to find. See `lib/mind/init-ledger.ts`.
 *
 * This is the second specimen of the #808 class and the reason it matters: #900
 * collapsed the daemon API to `/api/v1`, the template's hooks were updated, and
 * every mind that already existed kept calling the removed paths. Their
 * next-turn notices — page comments, auth failures, skipped schedules — piled up
 * undelivered for weeks while `volute mind upgrade`, the fix the daemon itself
 * recommended, could not touch a `.local/` file that was already there.
 *
 * One honest limit: a `.local/` file listed in the manifest's `substitute` is
 * rendered per-mind, so its on-disk bytes never match a raw shipped hash and it
 * would silently never refresh. No `.local/` file is substituted today, and
 * `test/template-init-classification.test.ts` pins that so it can't start
 * quietly.
 *
 * Returns the `home/`-relative paths in each bucket.
 *
 * These paths live under `home/.local/`, which the template `.gitignore` does
 * not allowlist, so this writes untracked files and cannot interact with the
 * upgrade's git merge.
 *
 * Throws rather than exiting when the template can't be composed. Both callers
 * run inside the daemon; the pre-checks below turn a missing templates root,
 * template dir, or manifest into a specific error message (rather than
 * composeTemplate/findTemplatesRoot's generic throw) so a broken install
 * degrades to one clear warning.
 */
export function backfillInitInfrastructure(
  homeDir: string,
  template: string,
  mindName: string,
  opts: { honorRemovals?: boolean } = {},
): { added: string[]; refreshed: string[]; withheld: string[] } {
  const honorRemovals = opts.honorRemovals ?? true;
  const root = locateTemplatesRoot();
  if (!root) throw new Error("templates root not found on disk");
  if (!existsSync(resolve(root, template))) {
    throw new Error(`template "${template}" not found at ${root}`);
  }
  // _base ships the shared manifest that every template merges into; its absence is
  // the manifest path composeTemplate throws on (a template's own manifest is now
  // optional). Pre-check it so a broken install degrades to one clear warning.
  if (!existsSync(resolve(root, "_base", "volute-template.json"))) {
    throw new Error(`base template manifest missing at ${root}/_base`);
  }

  const { composedDir, manifest } = composeTemplate(root, template);
  try {
    const initDir = resolve(composedDir, ".init");
    if (!existsSync(initDir)) return { added: [], refreshed: [], withheld: [] };

    // manifest.substitute paths are relative to the composed layout (".init/..."),
    // while listFiles() below yields paths relative to .init/ itself.
    const substitute = new Set(
      manifest.substitute
        .map((p) => p.split(sep).join("/"))
        .filter((p) => p.startsWith(".init/"))
        .map((p) => p.slice(".init/".length)),
    );
    const shipped = readShippedHashes(root);
    // What this mind has ever been given, and what it will have been given by the
    // end of this run. `given` only ever grows: a path the template has since
    // retired stays recorded, so if it is ever reintroduced the mind's removal of
    // it still counts.
    const ledger = readInitLedger(mindName);
    const given = new Set(ledger);
    const added: string[] = [];
    const refreshed: string[] = [];
    const withheld: string[] = [];

    /** Write the template's copy of `rel` to `dest`, rendering {{name}} if declared. */
    const install = (src: string, dest: string, rel: string) => {
      mkdirSync(dirname(dest), { recursive: true });
      if (substitute.has(rel)) {
        writeFileSync(dest, readFileSync(src, "utf-8").replaceAll("{{name}}", mindName));
        // cpSync would have carried the source mode across; a substituted file is
        // written fresh, so restore it (the `volute` shim has to stay executable).
        chmodSync(dest, statSync(src).mode);
      } else {
        cpSync(src, dest);
      }
    };

    for (const file of listFiles(initDir)) {
      const rel = file.split(sep).join("/");
      if (!isInitInfrastructure(rel)) continue;

      const src = resolve(initDir, file);
      const dest = resolve(homeDir, file);

      if (!existsSync(dest)) {
        // Absent, and we have given it to this mind before: the mind removed it.
        // That is authorship, and it outranks our confidence that the machinery
        // is good for it — including when the template ships newer bytes (#811).
        if (honorRemovals && ledger.has(rel)) {
          withheld.push(rel);
          continue;
        }
        install(src, dest, rel);
        added.push(rel);
        given.add(rel);
        continue;
      }

      // Present, so the mind has it — record that before anything else, since
      // that is the fact a future removal will be read against.
      given.add(rel);

      // Only replace it if the bytes on disk are ones Volute wrote.
      // An unreadable path (a directory where a file belongs, a permission the
      // daemon lost) is one mind's one file — it must not throw out of the loop
      // and take the *adds* for every remaining file down with it.
      let refreshable: boolean;
      try {
        refreshable = mayRefreshInfrastructure(readFileSync(dest), readFileSync(src), shipped[rel]);
      } catch {
        continue;
      }
      if (!refreshable) continue;

      install(src, dest, rel);
      refreshed.push(rel);
    }

    // Written once, at the end, and only with paths whose file was on disk during
    // this run — observed present, or installed a few lines above. An entry for a
    // file that never landed would read as "given, then removed" and withhold it
    // forever, so an install that throws must take the whole save down with it:
    // unrecorded installs are simply observed as present on the next run.
    if (given.size !== ledger.size) writeInitLedger(mindName, given);

    return { added, refreshed, withheld };
  } finally {
    rmSync(composedDir, { recursive: true, force: true });
  }
}

/** Per-runtime mechanics doc filename by template. */
const MECHANICS_DOCS: Record<string, string> = {
  claude: "CLAUDE.md",
  pi: "MINDS.md",
  codex: "AGENTS.md",
};

/** Whether `template` is a known built-in template. */
export function isKnownTemplate(template: string): boolean {
  return template in MECHANICS_DOCS;
}

/**
 * Swap the template-owned files under home/ (mechanics doc, .claude/settings.json,
 * and .config/config.json) to match a different template. Used when a mind switches
 * templates (e.g. claude → pi) during upgrade: these files are written at creation
 * time and excluded from the template branch (updateTemplateBranch strips all of
 * home/ except VOLUTE.md), so the normal upgrade merge never updates them.
 * Leaves mind-authored files (SOUL.md, MEMORY.md, memory/, etc.) untouched.
 */
export function applyTemplateHomeFiles(homeDir: string, template: string) {
  const root = findTemplatesRoot();

  // Resolve (and verify) the new mechanics doc before deleting the old one, so a
  // failure can't leave the mind with no mechanics doc at all.
  const newDoc = MECHANICS_DOCS[template];
  const newDocSrc = newDoc ? resolve(root, template, ".init", newDoc) : undefined;
  if (!newDocSrc || !existsSync(newDocSrc)) {
    throw new Error(`No mechanics doc for template "${template}"`);
  }

  // Mechanics doc: remove any existing one, then write the target's.
  for (const doc of Object.values(MECHANICS_DOCS)) {
    rmSync(resolve(homeDir, doc), { force: true });
  }
  cpSync(newDocSrc, resolve(homeDir, newDoc));

  // .claude/settings.json is claude-only.
  const settingsDest = resolve(homeDir, ".claude", "settings.json");
  if (template === "claude") {
    mkdirSync(dirname(settingsDest), { recursive: true });
    cpSync(resolve(root, "claude", ".init", ".claude", "settings.json"), settingsDest);
  } else {
    rmSync(settingsDest, { force: true });
  }

  // config.json: regenerate from the target's config (template-specific overrides _base).
  const templateConfig = resolve(root, template, "home", ".config", "config.json");
  const configSrc = existsSync(templateConfig)
    ? templateConfig
    : resolve(root, "_base", "home", ".config", "config.json");
  const configDest = resolve(homeDir, ".config", "config.json");
  mkdirSync(dirname(configDest), { recursive: true });
  writeFileSync(configDest, readFileSync(configSrc, "utf-8"));
}

/**
 * List all files in a directory recursively (relative paths).
 */
export function listFiles(dir: string): string[] {
  const results: string[] = [];
  function walk(current: string) {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      if (statSync(full).isDirectory()) {
        // Skip .git directories
        if (entry === ".git") continue;
        walk(full);
      } else {
        results.push(relative(dir, full));
      }
    }
  }
  walk(dir);
  return results;
}
