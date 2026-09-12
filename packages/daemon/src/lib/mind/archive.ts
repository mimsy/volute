import { execFileSync } from "node:child_process";
import type { Stats } from "node:fs";
import {
  chmodSync,
  closeSync,
  cpSync,
  existsSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import AdmZip from "adm-zip";
import { isInitInfrastructure } from "../template/template.js";
import { safeResolveWithinBase } from "../util/paths.js";
import { initLedgerPath } from "./init-ledger.js";
import { mindDir, stateDir } from "./registry.js";

export type ExportManifest = {
  version: 1;
  name: string;
  template: string;
  voluteVersion: string;
  exportedAt: string;
  format?: "home-only" | "full";
  stage?: "seed" | "sprouted";
  includes: {
    env: boolean;
    identity: boolean;
    connectors: boolean;
    history: boolean;
    sessions: boolean;
  };
};

export type ExportOptions = {
  name: string;
  template: string;
  stage?: "seed" | "sprouted";
  includeSrc?: boolean;
  includeEnv?: boolean;
  includeIdentity?: boolean;
  includeConnectors?: boolean;
  includeHistory?: boolean;
  includeSessions?: boolean;
};

/**
 * Directory names excluded wherever they appear, as restic matches them
 * (`lib/backup/restic.ts`): all of them are rebuilt from a lockfile or a
 * checkout, none of them is anything a mind wrote.
 *
 * Matched by name at any depth and against files too, not only directories — a
 * git *worktree*'s `.git` is a file holding a `gitdir:` pointer, and the pages
 * extension gives every mind one at `home/pages/_system/`. Archiving that stub
 * plants a path from the exporting host in the imported mind.
 */
const EXCLUDED_DIRS = new Set([
  "node_modules",
  ".variants",
  ".worktrees",
  ".git",
  ".venv",
  "venv",
  "__pycache__",
]);

/**
 * Runtime droppings that never belong in an archive, as posix paths relative
 * to the mind dir. Taken from restic's toolchain excludes
 * (`lib/backup/restic.ts`) — not every one of them, since restic matches a bare
 * name at any depth and these are exact subtrees — and, like restic, keeping
 * `home/.local/` itself: only its XDG toolchain subdirs go, because
 * `.local/hooks` and `.local/bin` are the mind's own (#1013).
 *
 * `.mind/tmp` is the mind's TMPDIR: the SDK leaves unix sockets there while the
 * mind runs (#1058). The rest are toolchain caches a mind installs into its
 * home — `home/.npm/_cacache` alone was 150 MB on a fresh mind (#1059).
 *
 * Applied to every path an export considers, both walked and git-listed. The
 * template's `.gitignore` already covers most of them on the git branch, but
 * that file lives in the mind's own writable tree, so leaning on it would make
 * the guarantee revocable by the untrusted party it constrains.
 */
const EXCLUDED_PATHS = [
  ".mind/tmp",
  "home/.npm",
  "home/.cache",
  "home/.rustup",
  "home/.cargo",
  "home/.local/share",
  "home/.local/state",
  "home/.local/lib",
  "home/.local/pipx",
];

/**
 * SDK runtime state, carried only when the export was asked for sessions.
 *
 * These exist at all only under `isolation: user`, where the SDK's HOME is
 * remapped into the mind dir; elsewhere they sit in the host's own `~/.claude`,
 * outside every export. `projects/` holds the transcripts that the session ids
 * in `.mind/sessions` resolve to, so dropping it unconditionally would bundle a
 * mind's session pointers with nothing to resume from — while carrying it by
 * default is most of the weight #1059 is about. Gated, the same way restic
 * gates the same paths.
 */
const SESSION_PATHS = [
  "home/.claude/projects",
  "home/.claude/debug",
  "home/.claude/telemetry",
  "home/.claude/todos",
  "home/.claude/session-env",
];

/** `.gitignore` rules and zip entry names both speak forward slashes. */
function toPosix(relPath: string): string {
  return relPath.split(sep).join("/");
}

/**
 * Whether a path `git ls-files` reported may be resolved against the mind dir.
 *
 * These come out of `.git/index`, which is the mind's own file — and while
 * `update-index` and `read-tree` both refuse a `..` component, nothing
 * re-validates an index written directly, which any mind with a shell can do,
 * so `ls-files` will print `home/../../etc/shadow` verbatim. Newly reachable,
 * too: naming the git dir is what makes this branch run at all under
 * `isolation: user`.
 *
 * Lexical only. It rejects `..` and absolute paths, which is all that can be
 * decided from the string; a symlink partway along the path is caught at the
 * read, by {@link readRegularFile}, which is where it has to be caught anyway
 * because the walked branches race the same way.
 */
function isContained(dir: string, relPath: string): boolean {
  return safeResolveWithinBase(dir, relPath) !== null;
}

/** Whether any segment of a mind-relative path names an {@link EXCLUDED_DIRS} dir. */
function hasExcludedDir(relPath: string): boolean {
  return toPosix(relPath)
    .split("/")
    .some((seg) => EXCLUDED_DIRS.has(seg));
}

/** Whether a mind-relative path is, or is inside, one of `subtrees`. */
function isUnder(relPath: string, subtrees: string[]): boolean {
  const rel = toPosix(relPath);
  return subtrees.some((ex) => rel === ex || rel.startsWith(`${ex}/`));
}

/** Whether a mind-relative path is dropped from every archive. */
function isExcludedPath(relPath: string): boolean {
  return isUnder(relPath, EXCLUDED_PATHS);
}

/** Whether a mind-relative path is dropped unless the export asked for sessions. */
function isSessionPath(relPath: string): boolean {
  return isUnder(relPath, SESSION_PATHS);
}

/**
 * Read a path into the archive, or decline to.
 *
 * The one gate on every read, because everything an export opens sits in a
 * directory the mind owns and can reshape while the export runs — which is the
 * whole premise of #1058. `base` must be an already realpath-resolved directory
 * the file has to be inside, and it is rechecked *here*, not at listing time:
 * `walkDir` refuses a symlinked directory when it walks, but the read happens
 * afterwards, and a running mind can swap a walked directory for a symlink in
 * between. Containing only at listing time left that race open on every branch,
 * full export included.
 *
 * The open is `O_NOFOLLOW`, so a symlink that appeared at the final component
 * since the listing is refused by the kernel (ELOOP) rather than followed, and
 * `O_NONBLOCK`, so a FIFO returns a handle instead of blocking the export for
 * good. `fstat` then judges the handle actually opened rather than a name that
 * may since have been re-pointed: only a regular file is read, which also turns
 * away a device node like `/dev/zero`.
 *
 * One window remains, and cannot be closed without `openat` on each path
 * segment, which Node does not expose: a parent directory swapped between the
 * `realpath` below and the `open`. Narrow, and it is a race against a process
 * the host is deliberately archiving.
 *
 * ENOENT/ENOTDIR/ELOOP mean the path is gone or was never a file, and are
 * skipped. Everything else is rethrown — see {@link isMissing}.
 */
function readRegularFile(fullPath: string, base: string): { data: Buffer; mode: number } | null {
  let fd: number | undefined;
  try {
    const realParent = realpathSync(dirname(fullPath));
    if (realParent !== base && !realParent.startsWith(base + sep)) return null;

    fd = openSync(
      join(realParent, basename(fullPath)),
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    );
    const stat = fstatSync(fd);
    if (!stat.isFile()) return null;
    return { data: readFileSync(fd), mode: stat.mode & 0o777 };
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Errors that mean the path simply is not there — the only ones an export may
 * pass over in silence.
 *
 * Everything else (EACCES, EPERM, EIO) says the file exists and could not be
 * read, and those are rethrown. An export that quietly omits what it could not
 * open is worse than one that fails: the archive looks complete, the exit code
 * says success, and the mind arrives on the new host with pieces missing that
 * nobody knows to look for.
 */
function isMissing(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException)?.code;
  return code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP";
}

/** A directory's real path, or `null` if it is not there. */
function safeRealpath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }
}

/**
 * Entries of a real directory, or `null` if it is absent, vanished, or is not a
 * directory at all — which includes a symlink to one, since `readdirSync`
 * follows those and a mind can plant one at any root an export descends into.
 */
function listDir(path: string): string[] | null {
  try {
    if (!lstatSync(path).isDirectory()) return null;
    return readdirSync(path);
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }
}

/**
 * Walk a directory tree, returning relative paths of regular files only.
 * Skips excluded dirs and optionally sessions.
 *
 * Every entry is judged by `lstat`, and only directories and regular files
 * survive. Symlinks are not descended into: following one would let a mind
 * point `home/projects` at `/minds` and have the export archive every other
 * mind, and the export may be running as root. Nor are they listed — Volute
 * creates none anywhere the export walks (the ones `npm install` leaves in
 * `node_modules/.bin` are cut by {@link EXCLUDED_DIRS}).
 *
 * The regular-file test for non-directories is the outer of two layers over the
 * same hazard: {@link readRegularFile} repeats it at the read, and has to,
 * because it also covers paths that never come through here — the git listing,
 * env.json, the ledger, the sessions bundle. Only that inner layer is load
 * bearing for what ends up in the archive. This one keeps the contract in the
 * signature honest: what comes back is a list of regular files.
 *
 * The same reasoning applies to the root: `readdirSync` follows a symlink, so a
 * root that is one is refused before it is enumerated.
 */
function walkDir(dir: string, base?: string, includeSessions?: boolean): string[] {
  const results: string[] = [];
  const entries = listDir(dir);
  if (!entries) return results;
  const baseDir = base ?? dir;

  for (const entry of entries) {
    const fullPath = resolve(dir, entry);
    const relPath = relative(baseDir, fullPath);
    if (isExcludedPath(relPath) || hasExcludedDir(relPath)) continue;
    if (!includeSessions && isSessionPath(relPath)) continue;

    let stat: Stats;
    try {
      stat = lstatSync(fullPath);
    } catch {
      // Lost a race with the running mind being exported; nothing to archive.
      continue;
    }

    if (stat.isDirectory()) {
      // Never walked in. Asked for, it is bundled under `sessions/` instead; not
      // asked for, it must not travel at all — an archive whose manifest says
      // `sessions: false` while carrying session pointers hands the new host a
      // mind holding an id that resolves to nothing.
      if (toPosix(relPath) === ".mind/sessions") continue;
      results.push(...walkDir(fullPath, baseDir, includeSessions));
    } else if (stat.isFile()) {
      results.push(relPath);
    }
  }

  return results;
}

/**
 * List files using git (tracked + untracked-but-not-ignored).
 * Falls back to walkDir if git fails (e.g. mind not a git repo).
 *
 * The repository is named, not discovered, and everything else is pinned,
 * because the repo being read belongs to the untrusted party.
 *
 * Under `isolation: user` the mind dir is owned by `mind-<name>` while the
 * export runs as the host, so git refused the repo as "dubious ownership" — and
 * on every production install this returned null, the fallback walk ran, and no
 * `.gitignore` rule ever applied (#1059). `--git-dir` settles that: the check
 * belongs to repository *discovery*, and naming the git dir skips discovery
 * altogether. It also stops discovery ascending out of a mind that is not a
 * repo into a host-owned parent that is, and it follows the pointer file a
 * variant's worktree uses in place of a `.git` directory.
 *
 * Bypassing the ownership check is the deliberate part, so what the check was
 * protecting against has to be pinned by hand. A repo's config can name a
 * command for git to run — `core.fsmonitor`, which both calls below reach, and
 * which fires even with no index on disk — and that config is mind-authored, so
 * it is pinned off. This is the one that must never be relaxed: on a system
 * install the export runs as root.
 *
 * `--work-tree` — not `-c core.worktree`, which repo config still wins over —
 * stops a mind setting `core.worktree = /` and making the export enumerate the
 * whole host filesystem, or `core.bare = true` and making it fail into the very
 * fallback #1059 is about.
 *
 * `-z` is not security, it is fidelity: without it git C-quotes any non-ASCII
 * path and emits newlines raw, so a mind that named a memory file with an emoji,
 * or with a newline in it, watched the file drop silently out of its own
 * archive. NUL-separated output has neither problem.
 */
function gitListFiles(dir: string): string[] | null {
  const git = (args: string[]) =>
    execFileSync(
      "git",
      [
        "-c",
        "core.fsmonitor=false",
        "--git-dir",
        join(dir, ".git"),
        "--work-tree",
        dir,
        ...args,
        "-z",
      ],
      {
        cwd: dir,
        encoding: "utf-8",
        // execFileSync defaults to 1 MB of stdout and throws ENOBUFS past it,
        // which the catch below would turn into exactly the #1059 failure it is
        // meant to end: warn, return null, walk, ship an oversize archive.
        maxBuffer: 64 * 1024 * 1024,
        // `mkfifo .gitignore` in the mind dir blocks `ls-files --others`
        // forever, and this is the synchronous CLI path, so `volute mind
        // export` would simply never return. Same for `.git/info/exclude`, a
        // `core.excludesFile` aimed at a FIFO or /dev/zero, and `.git/config`
        // itself, which is read before any `-c` can apply. ETIMEDOUT lands in
        // the catch below like any other git failure: the walk runs instead,
        // and the walk never opens a FIFO.
        timeout: 30_000,
      },
    );
  try {
    const tracked = git(["ls-files"]);
    const untracked = git(["ls-files", "--others", "--exclude-standard"]);
    const files = [...tracked.split("\0"), ...untracked.split("\0")].filter(Boolean);
    return [...new Set(files)];
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("not a git repository")) {
      console.error(
        `Warning: git ls-files failed, so the mind's .gitignore will not apply and the archive may be oversize: ${msg}`,
      );
    }
    return null;
  }
}

/**
 * The mind's infrastructure namespace inside `home/`, relative to the mind dir.
 *
 * `templates/_base/gitignore` ignores `home/*` and allowlists only the mind's
 * identity files, so `git ls-files` reports nothing at all under `.local/`.
 * Un-ignoring it there would start committing every mind's hooks into its own
 * repo, which is a different decision; the export instead names the subtree.
 */
const HOME_LOCAL_REL = join("home", ".local");

/**
 * The files that make up a mind's `home/` for a home-only export.
 *
 * One definition for both branches. Git is asked first so a mind's `.gitignore`
 * still keeps SDK session transcripts and other runtime droppings out of the
 * archive; when the mind isn't a git repo we walk `home/` instead. Either way
 * `home/.local/` — the mind's hooks and bin shims — is walked in explicitly,
 * because git will never report it (see {@link HOME_LOCAL_REL}) and because
 * whether a mind's edited hooks survive an export must not depend on whether
 * its home happens to be a git repo (#1013).
 */
function listHomeFiles(dir: string, includeSessions: boolean): string[] {
  const gitFiles = gitListFiles(dir);
  const files = gitFiles
    ? // `ls-files` always reports posix separators, so one prefix test is enough.
      gitFiles.filter((f) => f.startsWith("home/") && isContained(dir, f))
    : walkDir(resolve(dir, "home"), dir, includeSessions).map(toPosix);

  const localDir = resolve(dir, HOME_LOCAL_REL);
  files.push(...walkDir(localDir, dir, includeSessions).map(toPosix));

  // Walked in for the same reason `.local/` is: the template `.gitignore` hides
  // `home/.claude/*` from git, so on a git-repo mind — which is every ordinary
  // one — the gate below would never see these and `--include-sessions` would
  // bundle the session pointers with nothing to resume from.
  if (includeSessions) {
    for (const rel of SESSION_PATHS) {
      files.push(...walkDir(resolve(dir, rel), dir, true).map(toPosix));
    }
  }

  return [...new Set(files)].filter(
    (f) => !isExcludedPath(f) && !hasExcludedDir(f) && (includeSessions || !isSessionPath(f)),
  );
}

/**
 * Where a home-only archive carries the exporting mind's infrastructure ledger.
 *
 * Sits beside `state/env.json` because it is the same kind of thing: per-mind
 * state Volute keeps outside the mind's own directory. Absent from every
 * archive written before #1013, and from full archives (which are unaffected —
 * they copy a whole mind tree and compose no template, so nothing re-adds).
 */
export const ARCHIVE_INIT_LEDGER = "state/init-infrastructure.json";

/** Check if a manifest represents a home-only archive. */
export function isHomeOnlyArchive(manifest: ExportManifest): boolean {
  return manifest.format === "home-only";
}

/** Create an export archive zip from a mind. */
export function createExportArchive(options: ExportOptions): AdmZip {
  const {
    name,
    template,
    stage,
    includeSrc = false,
    includeEnv = false,
    includeIdentity = false,
    includeConnectors = false,
    includeHistory = false,
    includeSessions = false,
  } = options;

  // Resolved once, so the walks below can refuse a symlinked root without
  // refusing a host's own symlinked mind directory, and so every read below has
  // one real base to be contained against.
  const dir = realpathSync(mindDir(name));
  // Realpath-resolved for the same reason `dir` is: `readRegularFile` contains
  // every read against one of these, and the state dir is chowned to the mind
  // too. `null` when it does not exist yet, which is not an error.
  const state = safeRealpath(stateDir(name));
  const zip = new AdmZip();
  const format = includeSrc ? "full" : "home-only";

  if (includeSrc) {
    // Full export: walk entire mind directory (original behavior)
    const files = walkDir(dir, undefined, includeSessions);
    for (const relPath of files) {
      if (!includeIdentity && relPath.startsWith(join(".mind", "identity"))) continue;
      if (!includeConnectors && relPath.startsWith(join(".mind", "connectors"))) continue;
      const fullPath = resolve(dir, relPath);
      const file = readRegularFile(fullPath, dir);
      if (!file) continue;
      zip.addFile(`mind/${relPath}`, file.data);
    }
  } else {
    // Home-only export: listHomeFiles for home/, walkDir for .mind/
    for (const relPath of listHomeFiles(dir, includeSessions)) {
      const fullPath = resolve(dir, relPath);
      // `git ls-files` reports symlinks — including dangling ones and ones
      // pointing at a directory — so this branch needs the same guard the walks
      // apply, or a mind's `home/memory/x ->` anywhere turns into an EISDIR
      // crash or an archived host file.
      const file = readRegularFile(fullPath, dir);
      if (!file) continue;
      // Modes matter here as they do nowhere else in the archive: `.local/bin/`
      // holds the mind's `volute` wrapper and its skill shims, which are only
      // useful executable. adm-zip stamps 0644 on an entry added without one.
      zip.addFile(`mind/${relPath}`, file.data, "", file.mode);
    }

    // .mind/ files via walkDir (it's gitignored so git ls-files won't find it)
    const mindInternalDir = resolve(dir, ".mind");
    if (existsSync(mindInternalDir)) {
      const mindFiles = walkDir(mindInternalDir, dir, includeSessions);
      for (const relPath of mindFiles) {
        if (!includeIdentity && relPath.startsWith(join(".mind", "identity"))) continue;
        if (!includeConnectors && relPath.startsWith(join(".mind", "connectors"))) continue;
        const fullPath = resolve(dir, relPath);
        const file = readRegularFile(fullPath, dir);
        if (!file) continue;
        zip.addFile(`mind/${relPath}`, file.data);
      }
    }

    // The mind's infrastructure ledger, so the import can tell a hook it refused
    // from one that shipped after the export. See {@link overlayArchiveHome}.
    const ledger = state && readRegularFile(initLedgerPath(name), state);
    if (ledger) zip.addFile(ARCHIVE_INIT_LEDGER, ledger.data);
  }

  // Optionally include env.json from state dir
  // The state dir is chowned to the mind under `isolation: user`, so these two
  // are as mind-reshapable as anything inside the mind dir — see
  // {@link readRegularFile}.
  if (includeEnv && state) {
    const env = state && readRegularFile(resolve(state, "env.json"), state);
    if (env) zip.addFile("state/env.json", env.data);
  }

  // Optionally include session JSONL files from .mind/sessions/
  if (includeSessions) {
    // `.mind/` is the mind's own, so the directory and every entry in it get the
    // same treatment as the walks: `listDir` refuses a sessions dir the mind has
    // re-pointed at somewhere else, and the reads below are contained against it
    // — which also means a FIFO named `main.jsonl` cannot hang the export.
    const sessionsDir = resolve(dir, ".mind/sessions");
    for (const file of listDir(sessionsDir) ?? []) {
      if (!file.endsWith(".json") && !file.endsWith(".jsonl")) continue;
      const session = readRegularFile(resolve(sessionsDir, file), sessionsDir);
      if (!session) continue;
      zip.addFile(`sessions/${file}`, session.data);
    }
  }

  // Read version from package.json
  let voluteVersion = "unknown";
  try {
    const pkgPath = resolve(import.meta.dirname, "../../package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    voluteVersion = pkg.version;
  } catch {
    // Non-critical: archive works without exact version
  }

  // Write manifest
  const manifest: ExportManifest = {
    version: 1,
    name,
    template,
    voluteVersion,
    exportedAt: new Date().toISOString(),
    format,
    stage,
    includes: {
      env: includeEnv,
      identity: includeIdentity,
      connectors: includeConnectors,
      history: includeHistory,
      sessions: includeSessions,
    },
  };
  zip.addFile("manifest.json", Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));

  return zip;
}

/** Add history rows as JSONL to an existing zip. */
export function addHistoryToArchive(zip: AdmZip, rows: Array<Record<string, unknown>>): void {
  if (rows.length === 0) return;
  const lines = `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;
  zip.addFile("history.jsonl", Buffer.from(lines));
}

/** Read and validate the manifest from a .volute archive. */
export function readManifest(archivePath: string): ExportManifest {
  const zip = new AdmZip(archivePath);
  const entry = zip.getEntry("manifest.json");
  if (!entry) {
    throw new Error("Invalid archive: missing manifest.json");
  }
  const manifest = JSON.parse(entry.getData().toString("utf-8")) as ExportManifest;
  if (manifest.version !== 1) {
    throw new Error(`Unsupported archive version: ${manifest.version}`);
  }
  return manifest;
}

/**
 * Overlay a home-only archive's `home/` onto a freshly composed template's,
 * honouring the mind's refusals.
 *
 * The mind's own files winning over the template's defaults has always been
 * this step, and now that the archive carries `home/.local/` (#1013) that alone
 * preserves a hook the mind *edited*. A hook the mind *deleted* needs one thing
 * more, because absence in the archive is ambiguous in exactly the way #811
 * exists to resolve: "this mind removed it" and "this hook shipped after the
 * export" look identical, and guessing wrong either overrides the mind's own
 * authorship or withholds machinery from a mind that never declined it (#808).
 *
 * `given` — the exporting host's ledger, travelling with the archive — is what
 * separates them. A path that host recorded as given, and that the archive does
 * not carry, is a deletion the mind meant; it is removed from the fresh
 * template. A path absent from both is simply newer than the archive, and the
 * template's copy stands. An archive with no ledger says nothing about either,
 * so nothing is removed: that is every pre-#1013 archive.
 *
 * `given` is untrusted archive content, so each entry must be inside the
 * infrastructure namespace and must resolve within `destHome` before it can
 * delete anything.
 */
export function overlayArchiveHome(
  archiveHome: string,
  destHome: string,
  given: Iterable<string>,
): void {
  if (!existsSync(archiveHome)) return;

  for (const rel of given) {
    // Contain first, then judge the *contained* path: `.local/../.config` is
    // inside destHome and would pass a raw prefix test, which would let a
    // crafted archive delete freshly composed files outside the namespace.
    const target = safeResolveWithinBase(destHome, rel);
    if (!target) continue;
    const contained = relative(destHome, target);
    if (!isInitInfrastructure(contained)) continue;
    if (existsSync(resolve(archiveHome, contained))) continue;
    rmSync(target, { recursive: true, force: true });
  }

  cpSync(archiveHome, destHome, { recursive: true });
}

/** Extract a .volute archive to a destination directory.
 *  Returns the manifest and paths to extracted state files. */
export function extractArchive(
  archivePath: string,
  destDir: string,
): {
  manifest: ExportManifest;
  mindDir: string;
  envJson: string | null;
  historyJsonl: string | null;
  sessionsDir: string | null;
} {
  const zip = new AdmZip(archivePath);

  // Read manifest from the already-opened zip
  const manifestEntry = zip.getEntry("manifest.json");
  if (!manifestEntry) {
    throw new Error("Invalid archive: missing manifest.json");
  }
  const manifest = JSON.parse(manifestEntry.getData().toString("utf-8")) as ExportManifest;
  if (manifest.version !== 1) {
    throw new Error(`Unsupported archive version: ${manifest.version}`);
  }

  const normalizedDestDir = resolve(destDir);
  const extractedMindDir = resolve(normalizedDestDir, "mind");
  const extractedStateDir = resolve(normalizedDestDir, "state");
  mkdirSync(extractedMindDir, { recursive: true });
  mkdirSync(extractedStateDir, { recursive: true });

  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    const name = entry.entryName;

    if (name === "manifest.json") continue;

    const destPath = resolve(normalizedDestDir, name);
    // Prevent zip-slip path traversal
    if (!destPath.startsWith(`${normalizedDestDir}/`)) {
      throw new Error(`Archive contains path traversal entry: ${name}`);
    }
    mkdirSync(resolve(destPath, ".."), { recursive: true });
    writeFileSync(destPath, entry.getData());

    // Restore the executable bit, and only that. An archive is untrusted input:
    // taking its mode verbatim would let one plant a setuid file in a directory
    // the daemon then chowns to a mind. Non-executable entries are left at
    // whatever the write produced, so a strict umask is not widened either.
    if ((entry.header.fileAttr & 0o111) !== 0) chmodSync(destPath, 0o755);
  }

  const envJson = resolve(extractedStateDir, "env.json");
  const historyJsonl = resolve(normalizedDestDir, "history.jsonl");
  const sessionsDir = resolve(normalizedDestDir, "sessions");

  return {
    manifest,
    mindDir: extractedMindDir,
    envJson: existsSync(envJson) ? envJson : null,
    historyJsonl: existsSync(historyJsonl) ? historyJsonl : null,
    sessionsDir: existsSync(sessionsDir) ? sessionsDir : null,
  };
}
