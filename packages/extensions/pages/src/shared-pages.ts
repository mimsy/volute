/**
 * Git-based collaborative pages infrastructure.
 * Manages a central git repo with per-mind worktrees for collaborative system pages.
 * The repo lives in the pages extension data directory at <dataDir>/repo/.
 * Each mind gets a worktree at <mindDir>/home/pages/_system/ on a per-mind branch.
 */
import { execFile as execFileCb } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fchownSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { chownTree } from "@volute/daemon/lib/util/chown-tree.js";
import logger from "@volute/daemon/lib/util/logger.js";
import { buildMindBaseEnv } from "@volute/daemon/lib/util/mind-env.js";
import { isMultiplyLinkedFile } from "./ownership.js";

const log = logger.child("pages");

/** Isolation info needed by shared pages operations. */
export type IsolationInfo = {
  isIsolationEnabled: () => boolean;
  getMindUser: (name: string) => string;
  containMindPath: (name: string, path: string) => Promise<string>;
  wrapForIsolation: (cmd: string, args: string[], name: string) => Promise<[string, string[]]>;
};

/** Extract IsolationInfo from an ExtensionContext-shaped object. */
export function isolationFrom(ctx: IsolationInfo): IsolationInfo {
  return {
    isIsolationEnabled: ctx.isIsolationEnabled,
    getMindUser: ctx.getMindUser,
    containMindPath: ctx.containMindPath,
    wrapForIsolation: ctx.wrapForIsolation,
  };
}

/**
 * `chown -R` / `chgrp -R` for a pages tree, minus any file with a second name: a
 * mind can hard-link a root-owned file into the tree, and re-owning the link
 * re-owns the file (#1235). What it leaves alone is logged, not raised.
 */
async function chownPagesTree(path: string, owner: { user?: string; group: string }) {
  const skipped = await chownTree(path, owner);
  if (skipped.length > 0) {
    console.warn(`[pages] left hard-linked files under ${path} with their owner: ${skipped}`);
  }
}

/**
 * Give a tree under the mind's directory to the mind. The mind owns `home/` and
 * `home/pages`, so it can swap either for a symlink into another mind's pages;
 * `chownTree` never follows a symlinked root, but a swapped *parent* still
 * redirects the whole walk. Contained first, then chowned by its real path (#1248).
 */
async function chownToMindTree(isolation: IsolationInfo, mindName: string, path: string) {
  const root = await isolation.containMindPath(mindName, path);
  await chownPagesTree(root, { user: isolation.getMindUser(mindName), group: "volute" });
}

/**
 * Committer identity for pages commits. `--author` on the commit calls sets the
 * author but not the committer, so without this a host lacking a global git
 * identity fails at the commit step (leaving a partial repo). Setting it per
 * invocation keeps commits independent of host git config.
 */
const IDENTITY_ARGS = ["-c", "user.name=volute", "-c", "user.email=volute@localhost"];

/**
 * Where a git command runs, and as whom. `asMind` runs it as that mind under user
 * isolation, with `home` as its HOME; see `mindWorktree`. `pin` names a worktree's
 * vouched gitdir and the repo's `.git`, which git then uses in place of the pointer
 * files the mind can rewrite.
 */
type GitOpts = {
  cwd: string;
  asMind?: { name: string; home: string };
  pin?: { gitDir: string; commonDir: string };
};

/**
 * How long one git command may run. A mind owns its gitdir under `.git/worktrees/`,
 * and root's `worktree prune`, `branch -D` and checked-out-branch checks read every
 * gitdir there: a FIFO planted in one would otherwise hang the command, and the
 * pages lock it holds, forever.
 */
const GIT_TIMEOUT_MS = 120_000;
/** The most output a git call may return; past it the call fails. */
const GIT_MAX_OUTPUT = 16 * 1024 * 1024;

/**
 * Run a git command. Adds safe.directory when isolation is enabled, and a committer
 * identity so commits, and the commits a rebase replays, never depend on host or
 * mind git config.
 *
 * Hooks and fsmonitor are off for every call, so no git here runs a program it found
 * on disk that way. Git run as a mind doesn't auto-gc either: that would write
 * `.git/gc.pid` and `packed-refs`, which only root may write (`hardenPagesRepo`).
 *
 * The env is the daemon's mind allowlist, not `process.env`: the commit, merge and
 * rebase here run in worktrees minds write to, and a program a mind gets git to run
 * there (a filter driver, say) must not see `VOLUTE_DAEMON_TOKEN` (#966).
 */
async function gitExec(args: string[], opts: GitOpts, isolation?: IsolationInfo): Promise<string> {
  const isIso = isolation?.isIsolationEnabled() ?? false;
  const prefix = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...IDENTITY_ARGS];
  if (isIso) prefix.push("-c", "safe.directory=*");
  const env = buildMindBaseEnv();
  let [cmd, argv] = ["git", [...prefix, ...args]];
  if (isIso && opts.asMind) {
    argv = [...prefix, "-c", "gc.auto=0", "-c", "maintenance.auto=false", ...args];
    [cmd, argv] = await isolation!.wrapForIsolation(cmd, argv, opts.asMind.name);
    env.HOME = opts.asMind.home;
  } else if (opts.pin) {
    env.GIT_DIR = opts.pin.gitDir;
    env.GIT_COMMON_DIR = opts.pin.commonDir;
    env.GIT_WORK_TREE = opts.cwd;
  }
  return new Promise((resolve, reject) => {
    const execOpts = { cwd: opts.cwd, env, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_OUTPUT };
    execFileCb(cmd, argv, execOpts, (err, stdout, stderr) => {
      if (err) {
        const e = err as Error & { stderr?: string; stdout?: string };
        e.stderr = stderr;
        e.stdout = stdout;
        reject(err);
      } else {
        resolve(stdout);
      }
    });
  });
}

/**
 * A git pointer file (`.git`, `gitdir`) a mind may have swapped: read only if it is
 * a small regular file — never through a symlink, never a FIFO that would block the
 * daemon, never a device that reads forever.
 */
function readPointerFile(path: string, max = 4096): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > max) throw new Error(`${path} is not a git pointer file`);
    const buf = Buffer.alloc(st.size);
    readSync(fd, buf, 0, st.size, 0);
    return buf.toString("utf-8").trim();
  } finally {
    closeSync(fd);
  }
}

/**
 * The real path of the worktree's gitdir, or null if it can't be vouched for.
 *
 * The `.git` file naming it sits in the mind's worktree, so the mind can rewrite it
 * to point anywhere — including another mind's gitdir, which also lives in
 * `.git/worktrees/` (#1248). So the gitdir must be a direct child of the repo's
 * `.git/worktrees/`, and its `gitdir` back-pointer (written by git into the repo,
 * not the mind's tree) must lead back to this worktree, and its `commondir` must
 * lead to the repo's `.git` (#1357). `worktree` is the worktree's contained path.
 */
export function worktreeGitDir(repoDir: string, worktree: string): string | null {
  try {
    const realWorktree = realpathSync(worktree);
    const match = readPointerFile(resolve(realWorktree, ".git")).match(/^gitdir:\s*(.+)$/);
    if (!match) return null;
    const gitDir = realpathSync(resolve(realWorktree, match[1]));
    const commonDir = realpathSync(resolve(repoDir, ".git"));
    if (dirname(gitDir) !== realpathSync(resolve(commonDir, "worktrees"))) return null;
    // Relative under git's worktree.useRelativePaths, and then relative to the gitdir.
    const back = resolve(gitDir, readPointerFile(resolve(gitDir, "gitdir")));
    if (realpathSync(dirname(back)) !== realWorktree) return null;
    // The mind owns the gitdir too, and its `commondir` decides whose config git reads.
    const common = resolve(gitDir, readPointerFile(resolve(gitDir, "commondir")));
    if (realpathSync(common) !== commonDir) return null;
    return gitDir;
  } catch (err) {
    console.warn(`[pages] can't resolve the gitdir of ${worktree}: ${(err as Error).message}`);
    return null;
  }
}

/** Whether the worktree's `.git` names a gitdir that no longer exists. */
function isDanglingWorktree(wt: string): boolean {
  try {
    const match = readPointerFile(resolve(wt, ".git")).match(/^gitdir:\s*(.+)$/);
    return !!match && !existsSync(resolve(wt, match[1]));
  } catch {
    return false;
  }
}

/** Path to the collaborative pages repo within the extension data directory. */
export function pagesRepoDir(dataDir: string): string {
  return resolve(dataDir, "repo");
}

function worktreePath(mindDir: string): string {
  return resolve(mindDir, "home", "pages", "_system");
}

/**
 * Git options for the mind's worktree. Under user isolation the worktree is contained
 * first, because the mind owns `home/` and `home/pages` and can swap either for a
 * symlink into another mind's pages (#1285). Git then runs as the mind, not as root.
 * The worktree's gitdir is the mind's (`addPagesWorktree` hands it over), and its
 * `commondir` file decides which repo's config git reads. So root git here would run
 * any filter driver or other program that config names.
 *
 * Without isolation git runs as the daemon user, so it is pinned to the vouched gitdir
 * and the repo's `.git`: the mind can still rewrite `commondir` after the vouching,
 * and git never reads it (#1357). Throws if containment refuses, if the worktree isn't
 * there, or if its gitdir can't be vouched for.
 */
async function mindWorktree(
  mindName: string,
  mindDir: string,
  dir: string,
  isolation?: IsolationInfo,
): Promise<GitOpts> {
  const iso = isolation?.isIsolationEnabled();
  const cwd = iso
    ? await isolation!.containMindPath(mindName, worktreePath(mindDir))
    : worktreePath(mindDir);
  if (!existsSync(cwd)) {
    throw Object.assign(new Error(`${cwd} doesn't exist`), { code: "ENOENT" });
  }
  const gitDir = worktreeGitDir(dir, cwd);
  if (!gitDir) throw new Error(UNVERIFIED_WORKTREE.message);
  if (iso) return { cwd, asMind: { name: mindName, home: resolve(mindDir, "home") } };
  return { cwd, pin: { gitDir, commonDir: realpathSync(resolve(dir, ".git")) } };
}

/** Why nothing was published or pulled, in words for the mind. */
type Refusal = { ok: false; conflicts?: boolean; message: string };

/** What a mind is told when its worktree can't be contained. */
function refusedWorktree(mindName: string, err: unknown): Refusal {
  console.warn(`[pages] refused ${mindName}'s worktree: ${(err as Error).message}`);
  if ((err as Error).message === UNVERIFIED_WORKTREE.message) return UNVERIFIED_WORKTREE;
  if ((err as NodeJS.ErrnoException).code === "ENOENT") {
    // Never provisioned, or removed (#795).
    return {
      ok: false,
      message:
        "Nothing was done: pages/_system doesn't exist yet. It's set up when you start, " +
        "so restart and try again.",
    };
  }
  return {
    ok: false,
    message:
      `Nothing was done: pages/_system can't be used (${(err as Error).message}). ` +
      "If home/pages or pages/_system is a symlink or was moved, put the real directory back " +
      "(or move it aside and restart to provision a fresh worktree), then try again.",
  };
}

/**
 * Whether `dir` is a usable pages repo: a valid git repository with at least one
 * commit on HEAD. A husk `.git` left by an interrupted init (e.g. only a
 * `branches/` subdir), or a valid-but-commitless repo, both fail this probe.
 */
async function isRepoValid(dir: string, isolation?: IsolationInfo): Promise<boolean> {
  try {
    await gitExec(["rev-parse", "HEAD"], { cwd: dir }, isolation);
    return true;
  } catch {
    return false;
  }
}

/**
 * Give `path` `mode` through a handle opened without following a link, refusing
 * anything that isn't a `dir`/file the daemon owns. A file with a second name is
 * refused too: the chmod would reach whatever else that name is.
 */
function setDaemonMode(path: string, mode: number, dir: boolean): void {
  const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  const fd = openSync(path, dir ? flags | constants.O_DIRECTORY : flags);
  try {
    const st = fstatSync(fd);
    const wrongKind = dir ? !st.isDirectory() : !st.isFile() || isMultiplyLinkedFile(st);
    if (wrongKind || st.uid !== process.getuid?.()) {
      throw new Error(`${path} is not the daemon's own ${dir ? "directory" : "file"}`);
    }
    fchmodSync(fd, mode);
  } finally {
    closeSync(fd);
  }
}

/**
 * The repo config keys `git init` writes. Anything else in the config was put there
 * by someone else, when the config was still group-writable.
 */
const REPO_CONFIG_KEYS = new Set([
  "core.repositoryformatversion",
  "core.filemode",
  "core.bare",
  "core.logallrefupdates",
  "core.sharedrepository",
  "core.ignorecase",
  "core.precomposeunicode",
  "core.symlinks",
  "extensions.objectformat",
  "extensions.refstorage",
  "extensions.relativeworktrees",
  "receive.denynonfastforwards",
]);

/** Whether `path` is a regular file the daemon owns, with no second name. */
function isDaemonFile(path: string): boolean {
  try {
    const st = lstatSync(path);
    return st.isFile() && st.uid === process.getuid?.() && !isMultiplyLinkedFile(st);
  } catch {
    return false;
  }
}

/**
 * Keep the repo's own config, hooks and attributes the daemon's alone (#1285).
 *
 * `init --shared=group` makes all of `.git` writable by the `volute` group, and every
 * mind is in it. Root runs merge and commit here, and minds run git in their
 * worktrees, all reading this config. So a filter or merge driver, `include.path` or
 * `gpg.program` one mind wrote into it would run as root, or as every other mind.
 * Minds need only `objects/` and `refs/` (and their own gitdir under `worktrees/`)
 * to commit in their worktrees, so:
 *
 * - `.git`, `hooks/`, `info/` and `worktrees/` go to 2755. They are not
 *   group-writable at all, so no sticky bit is needed for a mind to be unable to
 *   rename `config` away or replace another mind's gitdir;
 * - a `config` or `HEAD` that isn't the daemon's own file is replaced, and history
 *   kept: `HEAD` names `main` again, and `git init` writes a fresh config. Both go
 *   to 0644, and `config` keeps only the keys `git init` writes;
 * - `hooks/` is emptied (hooks never run here), and `info/` keeps only an
 *   `exclude` that is the daemon's own file;
 * - `commondir`, `gitdir` and `config.worktree` in `.git` are removed: a main repo
 *   never has them, and each would change where git reads config from.
 *
 * Runs at every daemon start, so it also repairs installs from before it existed.
 * Throws if `.git` or one of those directories is not the daemon's own: the repo
 * can't be trusted, and the caller re-initializes it.
 */
export async function hardenPagesRepo(dir: string, isolation?: IsolationInfo): Promise<void> {
  const gitDir = resolve(dir, ".git");
  setDaemonMode(gitDir, 0o2755, true);
  for (const sub of ["hooks", "info", "worktrees"]) {
    const path = resolve(gitDir, sub);
    mkdirSync(path, { recursive: true });
    setDaemonMode(path, 0o2755, true);
  }
  for (const name of ["commondir", "gitdir", "config.worktree"]) {
    rmSync(resolve(gitDir, name), { recursive: true, force: true });
  }
  for (const name of readdirSync(resolve(gitDir, "hooks"))) {
    rmSync(resolve(gitDir, "hooks", name), { recursive: true, force: true });
  }
  for (const name of readdirSync(resolve(gitDir, "info"))) {
    const path = resolve(gitDir, "info", name);
    if (name === "exclude" && isDaemonFile(path)) chmodSync(path, 0o644);
    else rmSync(path, { recursive: true, force: true });
  }

  const head = resolve(gitDir, "HEAD");
  const config = resolve(gitDir, "config");
  if (!isDaemonFile(head)) {
    console.warn("[pages] replacing a pages repo HEAD that isn't the daemon's");
    rmSync(head, { recursive: true, force: true });
    writeFileSync(head, "ref: refs/heads/main\n");
  }
  if (!isDaemonFile(config)) {
    console.warn("[pages] replacing a pages repo config that isn't the daemon's");
    rmSync(config, { recursive: true, force: true });
    const shared = isolation?.isIsolationEnabled() ? ["--shared=group"] : [];
    await gitExec(["init", "-q", ...shared], { cwd: dir }, isolation);
    // A re-init re-applies the shared permissions it would give a new repo.
    return hardenPagesRepo(dir, isolation);
  }
  setDaemonMode(head, 0o644, false);
  setDaemonMode(config, 0o644, false);

  // Read and edited as a plain file, never as a repo's config: no include followed.
  const keys = await gitExec(
    ["config", "--file", config, "--no-includes", "--name-only", "--list"],
    { cwd: dirname(dir) },
  );
  for (const key of new Set(keys.split("\n").filter(Boolean))) {
    if (REPO_CONFIG_KEYS.has(key.toLowerCase())) continue;
    console.warn(`[pages] removing ${key} from the pages repo config`);
    await gitExec(["config", "--file", config, "--unset-all", key], { cwd: dirname(dir) });
  }
}

/** Idempotently initialize the collaborative pages git repo. */
export async function ensurePagesRepo(dataDir: string, isolation?: IsolationInfo): Promise<void> {
  const dir = pagesRepoDir(dataDir);
  mkdirSync(dir, { recursive: true });
  // The work tree itself is never wiped: if it isn't the daemon's own directory,
  // nothing here can be trusted to repair, so fail and leave it to a host.
  setDaemonMode(dir, 0o2755, true);

  if (existsSync(resolve(dir, ".git"))) {
    let trusted = true;
    try {
      await hardenPagesRepo(dir, isolation);
    } catch (err) {
      console.warn(`[pages] repo tampered with: ${(err as Error).message}`);
      trusted = false;
    }
    if (trusted && (await isRepoValid(dir, isolation))) return;
    // What's left — a husk .git from an interrupted init, a repo with no commits, or
    // a .git that isn't the daemon's — is wiped and re-initialized. That drops every
    // mind's branch, unpublished commits included; `addPagesWorktree` relinks each
    // worktree to the new repo on the mind's next start, keeping its files.
    console.warn("[pages] repo invalid or incomplete, re-initializing");
    rmSync(resolve(dir, ".git"), { recursive: true, force: true });
  }

  const isIso = isolation?.isIsolationEnabled() ?? false;
  const initArgs = isIso ? ["init", "--shared=group"] : ["init"];
  await gitExec(initArgs, { cwd: dir }, isolation);
  await gitExec(["checkout", "-b", "main"], { cwd: dir }, isolation);

  writeFileSync(resolve(dir, ".gitkeep"), "");
  await gitExec(["add", "-A"], { cwd: dir }, isolation);
  await gitExec(["commit", "-m", "init pages repo"], { cwd: dir }, isolation);

  if (isIso) {
    try {
      await chownPagesTree(dir, { group: "volute" });
    } catch {
      console.warn("[pages] failed to chgrp pages repo to volute group");
    }
  }
  await hardenPagesRepo(dir, isolation);
}

/**
 * Give the mind back what root's git left in its gitdir (#1326). Before #1307 root ran
 * git in every worktree, and a root-owned 0644 `COMMIT_EDITMSG` there fails every
 * commit the mind now runs as itself. Only the gitdir and the regular files directly
 * in it are looked at: those are what a commit rewrites, and what git writes deeper
 * (`logs/`) it makes group-writable under `--shared=group`.
 *
 * Each is opened without following a link and re-owned through that handle, and only
 * if `from` owns it and it has no second name, so no link steers the chown elsewhere,
 * and a gitdir with nothing of `from`'s in it costs one readdir and no chown. A mind
 * can still rename a daemon-owned file it could already replace (a loose object, say)
 * into its gitdir to be handed it; nothing trusts a file the daemon doesn't own, so
 * that gains it nothing. Returns what it re-owned.
 */
export function reclaimGitDir(
  gitDir: string,
  from: number,
  to: { uid: number; gid: number },
): string[] {
  const reowned: string[] = [];
  for (const path of [gitDir, ...readdirSync(gitDir).map((name) => resolve(gitDir, name))]) {
    let fd: number;
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch {
      continue; // a symlink, a socket, or gone
    }
    try {
      const st = fstatSync(fd);
      const kind = path === gitDir ? st.isDirectory() : st.isFile() && !isMultiplyLinkedFile(st);
      if (st.uid !== from || !kind) continue;
      fchownSync(fd, to.uid, to.gid);
      reowned.push(path);
    } finally {
      closeSync(fd);
    }
  }
  return reowned;
}

/**
 * `reclaimGitDir` for a mind's linked worktree, at every start. The ids are its
 * worktree's, which provisioning gave to the mind; one the daemon still owns names
 * no one to give anything to.
 */
async function reclaimWorktreeGitDir(
  dir: string,
  wt: string,
  mindName: string,
  isolation: IsolationInfo,
): Promise<void> {
  try {
    const contained = await isolation.containMindPath(mindName, wt);
    const gitDir = worktreeGitDir(dir, contained);
    const owner = lstatSync(contained);
    const daemon = process.getuid?.();
    if (!gitDir || daemon === undefined || owner.uid === daemon) return;
    const reowned = reclaimGitDir(gitDir, daemon, { uid: owner.uid, gid: owner.gid });
    if (reowned.length > 0) console.warn(`[pages] gave ${mindName} back ${reowned.join(", ")}`);
  } catch (err) {
    console.warn(`[pages] failed to reclaim ${mindName}'s gitdir: ${(err as Error).message}`);
  }
}

/**
 * Delete refs in a mind's worktree gitdir on the mind's behalf (#1330). Git takes the
 * common `.git/packed-refs.lock` to delete any ref, even one that lives only in a
 * worktree's gitdir, and `.git` is root's (`hardenPagesRepo`), so the mind's own git
 * never can. Every deletion here goes through this one function. The gitdir is one
 * `worktreeGitDir` vouched for, a direct child of root's `.git/worktrees/` the mind
 * can't swap, and unlinking a name never follows it. Returns what it removed.
 */
function dropGitDirRefs(gitDir: string, names: string[]): string[] {
  const removed: string[] = [];
  for (const name of names) {
    try {
      unlinkSync(resolve(gitDir, name));
      removed.push(name);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        log.warn("can't remove a ref from a mind's gitdir", {
          gitDir,
          name,
          ...logger.errorData(err),
        });
      }
    }
  }
  return removed;
}

/**
 * What a finished rebase, cherry-pick or revert leaves in the gitdir when the mind's
 * git can't delete it. `git status` then reports a cherry-pick that `--skip` and
 * `--abort` can't clear either, for the same reason.
 */
const FINISHED_OP_REFS = ["CHERRY_PICK_HEAD", "REVERT_HEAD", "REBASE_HEAD", "AUTO_MERGE"];

/** Whether `name` exists in the gitdir. Nothing is followed. */
function inGitDir(gitDir: string, name: string): boolean {
  try {
    lstatSync(resolve(gitDir, name));
    return true;
  } catch {
    return false;
  }
}

/** A small file git keeps in the gitdir, read as `readPointerFile` does, or null. */
function readGitDirFile(gitDir: string, name: string): string | null {
  try {
    return readPointerFile(resolve(gitDir, name), 1 << 16);
  } catch {
    return null;
  }
}

/** The branch the worktree is on, or the one a stopped rebase will return to. */
function branchOf(gitDir: string, rebasing: boolean): string | null {
  if (!rebasing) return readGitDirFile(gitDir, "HEAD")?.match(/^ref: (\S+)$/)?.[1] ?? null;
  return (
    readGitDirFile(gitDir, "rebase-merge/head-name") ??
    readGitDirFile(gitDir, "rebase-apply/head-name")
  );
}

/**
 * Whether the pick the mind is in is a revert, by git's own record: the todo list of
 * a multi-commit one, else the one head a single pick leaves. With both heads there
 * (one a leftover), the message git drafted says which.
 */
function pickingRevert(gitDir: string): boolean {
  const todo = readGitDirFile(gitDir, "sequencer/todo");
  if (todo !== null) return /^(revert|r)\s/.test(todo);
  const [cherry, revert] = [inGitDir(gitDir, "CHERRY_PICK_HEAD"), inGitDir(gitDir, "REVERT_HEAD")];
  if (cherry !== revert) return revert;
  return /^This reverts commit [0-9a-f]+/m.test(readGitDirFile(gitDir, "MERGE_MSG") ?? "");
}

function rebaseInProgress(gitDir: string): boolean {
  return inGitDir(gitDir, "rebase-merge") || inGitDir(gitDir, "rebase-apply");
}

/** The files the index holds unmerged, as the mind's git sees them. */
async function unmergedFiles(git: GitOpts, isolation?: IsolationInfo): Promise<string[]> {
  const out = await gitExec(["diff", "--name-only", "-z", "--diff-filter=U"], git, isolation);
  return [...new Set(out.split("\0").filter(Boolean))];
}

type WorktreeOp = "rebase" | "am" | "merge" | "cherry-pick" | "revert";

/** Whether the index differs from HEAD: something staged and not yet committed. */
async function hasStagedChanges(git: GitOpts, isolation?: IsolationInfo): Promise<boolean> {
  try {
    await gitExec(["diff", "--cached", "--quiet", "HEAD"], git, isolation);
    return false;
  } catch {
    return true;
  }
}

/**
 * Which git operation is in progress in the mind's worktree, if any, and what its
 * index holds unmerged. A finished operation's refs are deleted on the way, since the
 * mind can't. One the mind is still in the middle of is never touched: a stopped
 * rebase or `git am` (which shares `rebase-apply/`), a multi-commit cherry-pick or
 * revert (`sequencer/`), a merge, or a cherry-pick or revert not yet committed.
 */
async function inspectWorktree(
  gitDir: string,
  git: GitOpts,
  isolation?: IsolationInfo,
): Promise<{ op: WorktreeOp | null; unmerged: string[]; dropped: string[] }> {
  const unmerged = await unmergedFiles(git, isolation);
  const busy = (op: WorktreeOp) => ({ op, unmerged, dropped: [] });
  if (inGitDir(gitDir, "rebase-apply/applying")) return busy("am");
  if (rebaseInProgress(gitDir)) return busy("rebase");
  const picking = pickingRevert(gitDir) ? "revert" : "cherry-pick";
  if (inGitDir(gitDir, "sequencer")) return busy(picking);
  // Git deletes MERGE_HEAD as a file, not a ref, so the mind's own git clears it.
  if (inGitDir(gitDir, "MERGE_HEAD")) return busy("merge");
  // A pick head without MERGE_MSG is a leftover, not a pick in progress (#1335). A
  // stopped pick writes MERGE_MSG, and every way of ending one (commit, `--continue`,
  // `--skip`, `--abort`, `--quit`, a finished rebase) deletes it, a plain file the
  // mind's git can delete, while the head stays (checked on git 2.39 and 2.50). So
  // the mind's own changes staged over a leftover publish. The head's age can't say
  // more: git leaves a pseudoref unwritten when the value is unchanged, so picking the
  // very commit a leftover names keeps the leftover's mtime.
  const pickHead = inGitDir(gitDir, "CHERRY_PICK_HEAD") || inGitDir(gitDir, "REVERT_HEAD");
  const stopped = pickHead && inGitDir(gitDir, "MERGE_MSG");
  if (stopped && (unmerged.length > 0 || (await hasStagedChanges(git, isolation)))) {
    return busy(picking);
  }
  return { op: null, unmerged, dropped: dropGitDirRefs(gitDir, FINISHED_OP_REFS) };
}

/**
 * Clear what finished operations left in a mind's gitdir, at every start, for the
 * ones no pull or publish has come along to clear yet.
 */
async function tidyWorktreeGitDir(
  dir: string,
  mindName: string,
  mindDir: string,
  isolation: IsolationInfo,
): Promise<void> {
  try {
    const git = await mindWorktree(mindName, mindDir, dir, isolation);
    const gitDir = worktreeGitDir(dir, git.cwd);
    if (!gitDir) return;
    const { dropped } = await inspectWorktree(gitDir, git, isolation);
    if (dropped.length > 0) {
      log.info("cleared refs a finished git operation left", {
        mind: mindName,
        refs: dropped.join(", "),
      });
    }
  } catch (err) {
    log.warn("failed to tidy a mind's gitdir", { mind: mindName, ...logger.errorData(err) });
  }
}

/** Add a git worktree at <mindDir>/home/pages/_system/ on a per-mind branch. */
export async function addPagesWorktree(
  mindName: string,
  mindDir: string,
  dataDir: string,
  isolation?: IsolationInfo,
): Promise<void> {
  const dir = pagesRepoDir(dataDir);
  // Never shell into a broken repo: skip quietly and let ensurePagesRepo repair
  // it on the next daemon start rather than failing every mind start noisily.
  if (!(await isRepoValid(dir, isolation))) {
    console.warn(`[pages] repo not usable, skipping worktree for ${mindName}`);
    return;
  }

  // Under isolation the daemon is root, and the mind can swap `home` or `home/pages`
  // for a symlink into another mind's tree: contain each before root writes in it,
  // and hand git the real path (#1285).
  let pages = resolve(mindDir, "home", "pages");
  if (isolation?.isIsolationEnabled()) {
    try {
      const home = await isolation.containMindPath(mindName, resolve(mindDir, "home"));
      mkdirSync(resolve(home, "pages"), { recursive: true });
      pages = await isolation.containMindPath(mindName, resolve(home, "pages"));
    } catch (err) {
      console.warn(`[pages] refused ${mindName}'s home/pages: ${(err as Error).message}`);
      return;
    }
  } else {
    mkdirSync(pages, { recursive: true });
  }

  let wt = resolve(pages, "_system");
  let relink = false;
  if (existsSync(wt)) {
    // A real worktree has a `.git` file. A plain directory here is what a mind
    // creates by hand when publishing failed for lack of a worktree (#795) — say
    // so, because git then refuses to provision over it and every later publish
    // fails with an opaque `invalid upstream` deep inside the rebase.
    if (!existsSync(resolve(wt, ".git"))) {
      console.warn(
        `[pages] ${wt} exists but is not a worktree — shared publishing will fail for ${mindName}. Move it aside and restart the mind to provision one.`,
      );
      return;
    }
    if (!isDanglingWorktree(wt)) {
      if (isolation?.isIsolationEnabled()) {
        await reclaimWorktreeGitDir(dir, wt, mindName, isolation);
        await tidyWorktreeGitDir(dir, mindName, mindDir, isolation);
      }
      return;
    }
    // The repo was re-initialized under it: relink it, keeping the mind's files.
    if (isolation?.isIsolationEnabled()) {
      try {
        wt = await isolation.containMindPath(mindName, wt);
      } catch (err) {
        console.warn(`[pages] refused ${mindName}'s worktree: ${(err as Error).message}`);
        return;
      }
    }
    console.warn(`[pages] ${mindName}'s worktree lost its gitdir; relinking it`);
    relink = true;
  }

  let branchExists = false;
  try {
    await gitExec(["rev-parse", "--verify", mindName], { cwd: dir }, isolation);
    branchExists = true;
  } catch {
    // branch doesn't exist
  }

  // A relink checks the branch out nowhere, then moves its `.git` into the worktree.
  const target = relink ? resolve(pages, "._system.relink") : wt;
  if (relink) rmSync(target, { recursive: true, force: true });
  const add = relink ? ["worktree", "add", "--no-checkout"] : ["worktree", "add"];
  if (branchExists) {
    await gitExec([...add, target, mindName], { cwd: dir }, isolation);
  } else {
    await gitExec([...add, "-b", mindName, target], { cwd: dir }, isolation);
  }
  if (relink) {
    renameSync(resolve(target, ".git"), resolve(wt, ".git"));
    rmSync(target, { recursive: true, force: true });
    await gitExec(["worktree", "repair", wt], { cwd: dir }, isolation);
  }

  if (isolation?.isIsolationEnabled()) {
    // The daemon runs as root, so the home/pages it just provisioned is root-owned:
    // the whole of it goes to the mind (the worktree included), and so does the
    // worktree's gitdir, which lives in the repo, outside pages/. The gitdir is
    // resolved first, while the worktree's `.git` is still root's.
    let gitDir: string | null = null;
    try {
      gitDir = worktreeGitDir(dir, await isolation.containMindPath(mindName, wt));
    } catch (err) {
      console.warn(`[pages] refused the gitdir of ${wt}: ${(err as Error).message}`);
    }
    try {
      await chownToMindTree(isolation, mindName, pages);
    } catch (err) {
      console.warn(`[pages] failed to chown ${pages} for ${mindName}: ${(err as Error).message}`);
    }
    if (gitDir) {
      try {
        await chownPagesTree(gitDir, { user: isolation.getMindUser(mindName), group: "volute" });
      } catch (err) {
        console.warn(
          `[pages] failed to chown ${gitDir} for ${mindName}: ${(err as Error).message}`,
        );
      }
    }
  }
  // The index starts empty after `--no-checkout`: read it from the branch, as the
  // mind, so the mind's files show as its changes against the branch.
  if (relink)
    await gitExec(
      ["reset", "-q"],
      await mindWorktree(mindName, mindDir, dir, isolation),
      isolation,
    );
}

/** Remove the worktree and branch for a mind. */
export async function removePagesWorktree(
  mindName: string,
  mindDir: string,
  dataDir: string,
  isolation?: IsolationInfo,
): Promise<void> {
  const dir = pagesRepoDir(dataDir);
  if (!existsSync(resolve(dir, ".git"))) return;

  // `worktree remove --force` deletes the tree as root: never through a swapped link.
  let wt: string | null = worktreePath(mindDir);
  try {
    if (isolation?.isIsolationEnabled()) wt = await isolation.containMindPath(mindName, wt);
  } catch (err) {
    if (existsSync(wt)) {
      console.warn(`[pages] refused ${mindName}'s worktree: ${(err as Error).message}`);
    }
    wt = null;
  }

  if (wt && existsSync(wt)) {
    try {
      await gitExec(["worktree", "remove", "--force", wt], { cwd: dir }, isolation);
    } catch (err) {
      console.warn(`[pages] worktree remove failed for ${mindName}: ${(err as Error).message}`);
    }
  }

  try {
    await gitExec(["worktree", "prune"], { cwd: dir }, isolation);
  } catch (err) {
    console.warn(`[pages] worktree prune failed: ${(err as Error).message}`);
  }

  try {
    await gitExec(["branch", "-D", mindName], { cwd: dir }, isolation);
  } catch {
    // branch may not exist
  }
}

// Mutex for serializing merge/pull operations
let pagesLock = Promise.resolve();

async function withPagesLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = pagesLock;
  let resolve_: () => void;
  pagesLock = new Promise<void>((r) => {
    resolve_ = r;
  });
  await prev;
  try {
    return await fn();
  } finally {
    resolve_!();
  }
}

/**
 * Files `git add -A` would stage that have more than one name on disk, relative to
 * the worktree. Scoped by git itself — untracked and modified paths under the same
 * ignore rules `add -A` honours — so an ignored directory of legitimate hard links
 * (a pnpm `node_modules`) never blocks a publish. A tracked file swapped for a link
 * shows up as modified: its inode changes, and differing content is all that could
 * leak. Symlinks pass: `lstat` does not follow them, and git stores them as a path.
 */
async function findMultiplyLinkedFiles(git: GitOpts, isolation?: IsolationInfo): Promise<string[]> {
  const out = await gitExec(
    ["--no-optional-locks", "ls-files", "-z", "-o", "-m", "--exclude-standard"],
    git,
    isolation,
  );
  const found = new Set<string>();
  for (const rel of out.split("\0")) {
    if (!rel) continue;
    try {
      if (isMultiplyLinkedFile(lstatSync(resolve(git.cwd, rel)))) found.add(rel);
    } catch (err: any) {
      // Listed as modified because it was deleted, or removed since the listing.
      if (err?.code !== "ENOENT") throw err;
    }
  }
  return [...found].sort();
}

/** What a mind is told when files it would commit are hard links. */
function hardLinked(files: string[]): Refusal {
  const list = files.map((f) => `  ${f}`).join("\n");
  return {
    ok: false,
    message:
      `Nothing was committed. These files in pages/_system have a second name on disk (a hard link):\n${list}\n` +
      "Shared pages are committed by the daemon, which reads a file's contents with its own privileges, " +
      "so a hard-linked file can't be published. Replace each with an ordinary copy " +
      "(e.g. `cp <file> <file>.tmp && mv <file>.tmp <file>`) and try again.",
  };
}

/**
 * Stage whatever the mind has left uncommitted in its worktree, or refuse.
 *
 * `git add -A` stores a file by its *content*. It runs as the mind under user
 * isolation now (#1285), but it ran as root when #1095 was found, and it still runs
 * as the daemon's user without isolation. A hard link to a file the mind cannot read
 * (possible on macOS, which has no `protected_hardlinks`) would then be committed
 * with the daemon's privileges, and once squash-merged it is an ordinary file
 * everywhere, past every per-read guard from #1089. So what `add -A` would stage is
 * swept first, and the whole operation is refused if any of it has a second name.
 *
 * Like the containment checks in `ownership.ts`, this closes the durable hole, not
 * a link swapped in between the sweep and the `add`.
 */
async function stagePendingChanges(
  mindName: string,
  git: GitOpts,
  isolation?: IsolationInfo,
): Promise<Refusal | boolean> {
  const linked = await findMultiplyLinkedFiles(git, isolation);
  if (linked.length > 0) {
    console.warn(
      `[pages] refused to commit ${mindName}'s worktree: hard-linked ${linked.join(", ")}`,
    );
    return hardLinked(linked);
  }

  const status = (await gitExec(["status", "--porcelain"], git, isolation)).trim();
  if (!status) return false;
  await gitExec(["add", "-A"], git, isolation);
  return true;
}

/** `stagePendingChanges`, then commit what it staged. */
async function commitPendingChanges(
  mindName: string,
  git: GitOpts,
  isolation?: IsolationInfo,
): Promise<Refusal | null> {
  const staged = await stagePendingChanges(mindName, git, isolation);
  if (typeof staged !== "boolean") return staged;
  if (staged) {
    await gitExec(
      ["commit", "--author", `${mindName} <${mindName}@volute>`, "-m", `wip: ${mindName}`],
      git,
      isolation,
    );
  }
  return null;
}

/**
 * How every shared refusal names the way to publish again. Written out in full: a plain
 * `volute pages publish` only publishes personal pages, and a mind told just to
 * "publish again" ran that and believed its commons changes had gone out.
 */
const PUBLISH_SHARED = '`volute pages publish --shared "<note>"`';

/**
 * What a mind is told when its rebase onto main stopped on a conflict. The rebase is
 * left stopped, so `git status` in pages/_system shows the same thing (#1330).
 */
function stoppedOnConflict(files: string[]): Refusal {
  return {
    ok: false,
    conflicts: true,
    message:
      "Nothing was published. Your pages are being rebased onto main, and the rebase " +
      `stopped on a conflict in pages/_system: ${files.join(", ")}. In pages/_system, ` +
      "edit each of those files to what it should say (removing the <<<<<<< ======= >>>>>>> " +
      `markers) and \`git add\` it, then publish again with ${PUBLISH_SHARED}: publishing ` +
      "commits the rest of your changes and finishes the rebase. `git status` will suggest " +
      "`git rebase --continue`; that's git's generic hint, so publish again instead: git " +
      "can't delete its own bookkeeping refs in this repo, so it prints errors about " +
      "packed-refs.lock and can leave the rebase half-finished. If you already ran it, " +
      "publishing again still recovers: first check those files have no <<<<<<< lines left. " +
      "Once the rebase is through, publishing still refuses a whole <<<<<<< ======= >>>>>>> " +
      "conflict left in a file, but a single stray marker line gets through. To set the rebase aside " +
      "instead, `git rebase --abort` puts your branch back as it was (with the same " +
      "packed-refs.lock errors), but it also discards every edit made in pages/_system " +
      "since the rebase stopped, so copy out any you want to keep first. The next publish " +
      "meets this conflict again.",
  };
}

const CONFLICT_MARKER = "^<{7}( |$)";

/** `git grep -l` for a conflict marker in `paths` of `rev`, or of the index. */
async function grepMarkers(
  rev: string | null,
  paths: string[],
  git: GitOpts,
  isolation?: IsolationInfo,
): Promise<string[]> {
  const found: string[] = [];
  for (let i = 0; i < paths.length; i += 200) {
    const chunk = paths.slice(i, i + 200);
    const where = rev ? ["-E", CONFLICT_MARKER, rev] : ["--cached", "-E", CONFLICT_MARKER];
    const args = ["--literal-pathspecs", "grep", "-l", "-z", ...where];
    try {
      const out = await gitExec([...args, "--", ...chunk], git, isolation);
      found.push(...out.split("\0").filter(Boolean));
    } catch (err) {
      if ((err as { code?: unknown }).code !== 1) throw err; // 1: no match
    }
  }
  return found;
}

/**
 * Files the stopped pick conflicted in that still hold a `<<<<<<<` line, staged or
 * already committed. Only the files the commit being replayed (REBASE_HEAD) changes
 * can have conflicted, and a marker line that commit already had is the mind's own
 * content, so neither blocks.
 */
async function filesWithMarkers(git: GitOpts, isolation?: IsolationInfo): Promise<string[]> {
  let picked: string[];
  try {
    const args = ["diff-tree", "-r", "--root", "--no-commit-id", "--name-only", "-z"];
    picked = (await gitExec([...args, "REBASE_HEAD"], git, isolation)).split("\0").filter(Boolean);
  } catch {
    return []; // no REBASE_HEAD: not stopped on a pick
  }
  const marked = await grepMarkers(null, picked, git, isolation);
  if (marked.length === 0) return [];
  const own = new Set(
    (await grepMarkers("REBASE_HEAD", marked, git, isolation)).map((p) =>
      p.replace(/^REBASE_HEAD:/, ""),
    ),
  );
  return marked.filter((p) => !own.has(p));
}

/** What git printed, without the packed-refs.lock lines it prints for every ref it can't delete. */
function gitSaid(err: unknown): string {
  const e = err as Error & { stdout?: string; stderr?: string };
  const lines = `${e.stdout ?? ""}\n${e.stderr ?? ""}`.split("\n");
  return lines.filter((l) => l.trim() && !l.includes("packed-refs.lock")).join("\n") || e.message;
}

/**
 * Finish a rebase stopped in the mind's worktree, once nothing is left unmerged. The
 * rest of the mind's changes go into the commit being replayed, never a conflict
 * marker. CHERRY_PICK_HEAD goes first: with nothing new staged (the mind's resolution
 * already committed), `rebase --continue` must delete it, and fails for good when it
 * can't.
 */
async function finishStoppedRebase(
  mindName: string,
  gitDir: string,
  git: GitOpts,
  unmerged: string[],
  isolation?: IsolationInfo,
): Promise<Refusal | null> {
  if (unmerged.length > 0) return stoppedOnConflict(unmerged);
  const staged = await stagePendingChanges(mindName, git, isolation);
  if (typeof staged !== "boolean") return staged;
  const marked = await filesWithMarkers(git, isolation);
  if (marked.length > 0) return markersMidRebase(marked);
  dropGitDirRefs(gitDir, ["CHERRY_PICK_HEAD"]);
  try {
    await gitExec(["-c", "core.editor=true", "rebase", "--continue"], git, isolation);
  } catch (err) {
    // A later commit of the mind's can stop on a conflict of its own.
    const next = rebaseInProgress(gitDir) ? await unmergedFiles(git, isolation) : [];
    if (next.length > 0) return stoppedOnConflict(next);
    return rebaseUnfinished(gitSaid(err));
  }
  dropGitDirRefs(gitDir, FINISHED_OP_REFS);
  return null;
}

/** What a mind is told when its resolution of a stopped rebase still has markers in it. */
function markersMidRebase(files: string[]): Refusal {
  return {
    ok: false,
    conflicts: true,
    message:
      "Nothing was published. Your pages are being rebased onto main, and these files in " +
      `pages/_system still have conflict markers (<<<<<<<) in them: ${files.join(", ")}. ` +
      `Edit each to what it should say, then publish again with ${PUBLISH_SHARED}. Or, to ` +
      "set the rebase aside, " +
      "`git rebase --abort` puts your branch back as it was (git prints errors about " +
      "packed-refs.lock as it does), but it also discards every edit made in " +
      "pages/_system since the rebase stopped, so copy out any you want to keep first. " +
      "The next publish meets the same conflict.",
  };
}

/** What a mind is told when finishing its stopped rebase failed for a reason git gave. */
function rebaseUnfinished(said: string): Refusal {
  return {
    ok: false,
    message:
      "Nothing was published. Your pages are being rebased onto main, and the rebase " +
      `couldn't be finished. Git said:\n${said}\n` +
      "`git status` in pages/_system shows where it stands. Once that's sorted, publish " +
      `again with ${PUBLISH_SHARED}.`,
  };
}

/**
 * What a mind is told when a git operation it started is still in progress. Every
 * way out keeps the mind's changes, never a reset that would discard them (#1335). A
 * merge is ended with `--quit`, not committed: publishing rebases the branch onto
 * main, and a rebase drops merge commits along with whatever was changed in them.
 */
function operationInProgress(op: Exclude<WorktreeOp, "rebase">): Refusal {
  const keeps =
    "which keeps everything it changed as your own uncommitted edits, for publishing to commit";
  const finish =
    op === "am"
      ? "`git am --continue`"
      : `resolve the conflicts, \`git add\`, then \`git ${op} --continue\``;
  const ways =
    op === "merge"
      ? "Resolve the conflicts and `git add` them, then end it with `git merge --quit`, " +
        `${keeps}. Don't commit the merge: publishing rebases your branch onto main, which ` +
        "drops merge commits along with what was changed in them"
      : `Finish it (${finish}), or stop it with \`git ${op} --quit\`, ${keeps}`;
  const what = op === "am" ? "`git am`" : `a ${op}`;
  return {
    ok: false,
    message:
      `Nothing was published: ${what} you started in pages/_system is still in progress, ` +
      `and publishing would commit it half-done. ${ways}. Git may print errors about ` +
      "packed-refs.lock as it does: it can't delete its bookkeeping refs in this repo, and " +
      `the next publish clears them. Then publish again with ${PUBLISH_SHARED}.`,
  };
}

/** What a mind is told when its index still holds conflicts no operation is waiting on. */
function unresolvedConflicts(files: string[]): Refusal {
  return {
    ok: false,
    conflicts: true,
    message:
      "Nothing was published: these files in pages/_system are still marked as conflicted: " +
      `${files.join(", ")}. Edit each to what it should say (removing the <<<<<<< ======= ` +
      `>>>>>>> markers) and \`git add\` it, then publish again with ${PUBLISH_SHARED}.`,
  };
}

/** What a mind is told when what it would publish adds a conflict git left in a file. */
function conflictInBranch(files: string[]): Refusal {
  return {
    ok: false,
    conflicts: true,
    message:
      "Nothing was published: these files in pages/_system have a conflict in them (the " +
      `<<<<<<< ======= >>>>>>> lines a git conflict leaves): ${files.join(", ")}. Edit each ` +
      `to what it should say, then publish again with ${PUBLISH_SHARED}. If a page is meant ` +
      "to show those lines, " +
      "indent them.",
  };
}

/** What a mind is told when what it would publish can't be checked for conflicts. */
const TOO_LARGE_TO_CHECK: Refusal = {
  ok: false,
  message:
    "Nothing was published: your changes in pages/_system are too large to check for " +
    "conflict markers (over 16 MB of changes to files with ======= lines in them), and " +
    "they aren't sent unchecked. Making those files smaller gets them through.",
};

/**
 * What a mind is told when pages/_system isn't on its own branch. A rebase it started
 * there is finished first, not quit: the commits it hadn't replayed yet would be
 * left behind where `git log` doesn't show them.
 */
function notOnBranch(branch: string, rebasing = false): Refusal {
  const finishFirst = rebasing
    ? "A rebase you started there is still in progress, and `git switch` refuses until " +
      "it's done: finish it first (resolve the conflicts, `git add`, then " +
      "`git rebase --continue`, which prints errors about packed-refs.lock that the next " +
      "publish clears). "
    : "";
  return {
    ok: false,
    message:
      `Nothing was published: pages/_system isn't on your branch (${branch}), so what's ` +
      `there isn't what publishing would send. ${finishFirst}` +
      "`git status` there shows where it is. If you " +
      "committed anything there, note each commit first (`git log --oneline` lists them). " +
      `Then \`git switch ${branch}\`: if git says that would overwrite your uncommitted ` +
      "changes, it refuses and changes nothing, so copy those files out, switch, and put " +
      "them back. Bring each commit you noted back with `git cherry-pick <commit>`, then " +
      `publish again with ${PUBLISH_SHARED}.`,
  };
}
/** What a mind is told when its worktree's gitdir can't be vouched for. */
const UNVERIFIED_WORKTREE: Refusal = {
  ok: false,
  message:
    "Nothing was done: pages/_system's .git doesn't lead to its place in the shared pages " +
    "repo, so its state can't be checked. Move pages/_system aside and restart to provision " +
    "a fresh worktree (your files stay in the copy you moved), then try again.",
};

/** How daemon-side git reaches a mind's worktree, for tests to drive. */
export const WORKTREE_GIT = { mindWorktree, gitExec };

/** Every refusal a mind can be given about its worktree's git state, for tests to read. */
export const REFUSALS = {
  refusedWorktree,
  hardLinked,
  stoppedOnConflict,
  markersMidRebase,
  rebaseUnfinished,
  operationInProgress,
  unresolvedConflicts,
  conflictInBranch,
  TOO_LARGE_TO_CHECK,
  notOnBranch,
  UNVERIFIED_WORKTREE,
};

/**
 * Bring the mind's worktree to where a commit can start: a rebase it left stopped is
 * finished, or the mind is told what's still in the way. Returns the vouched gitdir.
 */
async function settleWorktree(
  mindName: string,
  dir: string,
  git: GitOpts,
  isolation?: IsolationInfo,
): Promise<{ gitDir: string } | { refused: Refusal }> {
  const gitDir = worktreeGitDir(dir, git.cwd);
  if (!gitDir) return { refused: UNVERIFIED_WORKTREE };
  const { op, unmerged } = await inspectWorktree(gitDir, git, isolation);
  // Anything in progress other than a rebase is named first, and conflicts it left:
  // `git switch`, the way back to the branch, refuses while either is there.
  if (op && op !== "rebase") return { refused: operationInProgress(op) };
  const rebasing = op === "rebase";
  if (!rebasing && unmerged.length > 0) return { refused: unresolvedConflicts(unmerged) };
  // A rebase runs detached, and is finished only onto the branch it returns to. A
  // commit anywhere else would land off the branch that publishing sends and resets,
  // as after a `git rebase --quit`.
  if (branchOf(gitDir, rebasing) !== `refs/heads/${mindName}`) {
    // Not ours to finish, but the mind's own `--continue` fails for good on the
    // CHERRY_PICK_HEAD it can't delete once its resolution is staged or committed.
    if (rebasing && unmerged.length === 0) dropGitDirRefs(gitDir, ["CHERRY_PICK_HEAD"]);
    return { refused: notOnBranch(mindName, rebasing) };
  }
  if (rebasing) {
    const refused = await finishStoppedRebase(mindName, gitDir, git, unmerged, isolation);
    if (refused) return { refused };
  }
  return { gitDir };
}

/**
 * Commit what the mind left, then rebase its branch onto main, as the mind. A conflict
 * leaves the rebase stopped for the mind to resolve with git's ordinary workflow: an
 * aborted one would leave nothing to resolve (#1330).
 */
async function pullIntoWorktree(
  mindName: string,
  dir: string,
  git: GitOpts,
  isolation?: IsolationInfo,
): Promise<Refusal | null> {
  const settled = await settleWorktree(mindName, dir, git, isolation);
  if ("refused" in settled) return settled.refused;
  const { gitDir } = settled;
  const uncommittable = await commitPendingChanges(mindName, git, isolation);
  if (uncommittable) return uncommittable;

  try {
    await gitExec(["rebase", "main"], git, isolation);
  } catch (err) {
    if (rebaseInProgress(gitDir)) {
      const files = await unmergedFiles(git, isolation);
      if (files.length > 0) return stoppedOnConflict(files);
      try {
        await gitExec(["rebase", "--abort"], git, isolation);
      } catch (abortErr) {
        log.error("rebase abort failed", { mind: mindName, ...logger.errorData(abortErr) });
      }
    }
    if (!rebaseInProgress(gitDir)) dropGitDirRefs(gitDir, FINISHED_OP_REFS);
    log.error("pull rebase failed", { mind: mindName, ...logger.errorData(err) });
    return { ok: false, message: `Pull failed. Git said:\n${gitSaid(err)}` };
  }

  // The rebase finished, so what it couldn't delete is only bookkeeping now.
  dropGitDirRefs(gitDir, FINISHED_OP_REFS);
  return null;
}

/**
 * Files to which the mind's branch adds a whole conflict (a `<<<<<<<`, `=======` and
 * `>>>>>>>` line, in order, all added), whatever committed it: publishing, the mind,
 * auto-commit or `git rebase --continue` (#1335). Only added lines count, so a page
 * that already showed a conflict can't hide a new one, while one moved to a new name
 * isn't mistaken for one. Every file is read as text, whatever a `.gitattributes` the
 * mind published says. Only files whose diff touches a `=======` line are diffed in
 * full. Null when that diff is too large to read, so it can't be checked.
 */
async function conflictsAdded(
  dir: string,
  branch: string,
  isolation?: IsolationInfo,
): Promise<string[] | null> {
  const args = ["diff", "--text", "--no-textconv", "--no-color", "--no-ext-diff", "-U0"];
  let out: string;
  try {
    out = await gitExec([...args, "-G^=======", `main...${branch}`], { cwd: dir }, isolation);
  } catch (err) {
    if ((err as { code?: unknown }).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return null;
    throw err;
  }
  const marks = [/^<{7}( .*)?\r?$/, /^={7}\r?$/, /^>{7}( .*)?\r?$/];
  const found = new Set<string>();
  let [file, header, next] = ["", false, 0];
  for (const line of out.split("\n")) {
    if (line.startsWith("diff --git ")) [file, header, next] = ["", true, 0];
    else if (header) {
      if (line.startsWith("+++ "))
        file = line
          .slice(4)
          .replace(/^"?b\//, "")
          .replace(/"$/, "");
      if (line.startsWith("@@")) header = false;
    } else if (line.startsWith("+") && marks[next].test(line.slice(1))) {
      next = (next + 1) % marks.length;
      if (next === 0) found.add(file);
    }
  }
  return [...found];
}
/**
 * Squash-merge a mind's branch into main, then reset the mind's branch.
 */
export async function pagesMerge(
  mindName: string,
  mindDir: string,
  dataDir: string,
  message: string,
  isolation?: IsolationInfo,
): Promise<{ ok: boolean; conflicts?: boolean; message?: string }> {
  return withPagesLock(async () => {
    const dir = pagesRepoDir(dataDir);
    let wt: GitOpts;
    try {
      wt = await mindWorktree(mindName, mindDir, pagesRepoDir(dataDir), isolation);
    } catch (err) {
      return refusedWorktree(mindName, err);
    }

    const settled = await settleWorktree(mindName, dir, wt, isolation);
    if ("refused" in settled) return settled.refused;
    const refused = await commitPendingChanges(mindName, wt, isolation);
    if (refused) return refused;

    // Check if there's anything to merge
    const diff = (
      await gitExec(["diff", `main...${mindName}`, "--stat"], { cwd: dir }, isolation)
    ).trim();
    if (!diff) {
      return { ok: true, message: "Nothing to publish" };
    }
    const conflicted = await conflictsAdded(dir, mindName, isolation);
    if (!conflicted) return TOO_LARGE_TO_CHECK;
    if (conflicted.length > 0) return conflictInBranch(conflicted);

    // Squash-merge into main
    try {
      await gitExec(["merge", "--squash", mindName], { cwd: dir }, isolation);
    } catch (err) {
      const errOutput = [
        (err as Error).message,
        (err as Error & { stderr?: string }).stderr ?? "",
        (err as Error & { stdout?: string }).stdout ?? "",
      ].join("\n");
      const isConflict = errOutput.includes("CONFLICT") || errOutput.includes("could not apply");
      try {
        await gitExec(["reset", "--hard", "HEAD"], { cwd: dir }, isolation);
      } catch (resetErr: unknown) {
        console.error("[pages] reset after squash conflict failed", resetErr);
      }
      if (isConflict) {
        return { ok: false, conflicts: true, message: "Merge conflicts detected" };
      }
      return { ok: false, message: `Merge failed: ${(err as Error).message}` };
    }

    await gitExec(
      ["commit", "--author", `${mindName} <${mindName}@volute>`, "-m", message],
      { cwd: dir },
      isolation,
    );

    // Reset mind's branch to main
    try {
      await gitExec(["reset", "--hard", "main"], wt, isolation);
    } catch (err: unknown) {
      console.error(`[pages] branch reset failed for ${mindName}`, err);
      return {
        ok: true,
        message: "Published to main, but branch reset failed — run 'volute pages pull' to sync",
      };
    }

    if (isolation?.isIsolationEnabled()) {
      try {
        await chownToMindTree(isolation, mindName, wt.cwd);
      } catch (err) {
        // Non-fatal: mind still functions but may hit permission errors
        console.warn(
          `[pages] failed to chown ${wt.cwd} for ${mindName}: ${(err as Error).message}`,
        );
      }
    }

    return { ok: true };
  });
}

/**
 * Pull latest changes by rebasing the mind's branch onto main.
 */
export async function pagesPull(
  mindName: string,
  mindDir: string,
  dataDir: string,
  isolation?: IsolationInfo,
): Promise<{ ok: boolean; conflicts?: boolean; message?: string }> {
  return withPagesLock(async () => {
    let wt: GitOpts;
    try {
      wt = await mindWorktree(mindName, mindDir, pagesRepoDir(dataDir), isolation);
    } catch (err) {
      return refusedWorktree(mindName, err);
    }

    const refused = await pullIntoWorktree(mindName, pagesRepoDir(dataDir), wt, isolation);
    if (refused) return refused;

    if (isolation?.isIsolationEnabled()) {
      try {
        await chownToMindTree(isolation, mindName, wt.cwd);
      } catch (err) {
        console.warn(
          `[pages] failed to chown ${wt.cwd} for ${mindName}: ${(err as Error).message}`,
        );
      }
    }

    return { ok: true, message: "Pulled latest shared changes." };
  });
}

/**
 * Pull then merge in a single lock acquisition.
 * Without this, another mind could publish between our pull and merge, causing unnecessary conflicts.
 */
export async function pagesPullAndMerge(
  mindName: string,
  mindDir: string,
  dataDir: string,
  message: string,
  isolation?: IsolationInfo,
): Promise<{
  ok: boolean;
  conflicts?: boolean;
  message?: string;
  changedFiles?: string[];
  priorAuthors?: Record<string, string[]>;
}> {
  return withPagesLock(async () => {
    const dir = pagesRepoDir(dataDir);
    let wt: GitOpts;
    try {
      wt = await mindWorktree(mindName, mindDir, pagesRepoDir(dataDir), isolation);
    } catch (err) {
      return refusedWorktree(mindName, err);
    }

    // Commit pending changes once (shared by pull and merge), then rebase onto main.
    const refused = await pullIntoWorktree(mindName, dir, wt, isolation);
    if (refused) return refused;

    // Check if there's anything to merge
    const diff = (
      await gitExec(["diff", `main...${mindName}`, "--stat"], { cwd: dir }, isolation)
    ).trim();
    if (!diff) {
      return { ok: true, message: "Nothing to publish" };
    }
    const conflicted = await conflictsAdded(dir, mindName, isolation);
    if (!conflicted) return TOO_LARGE_TO_CHECK;
    if (conflicted.length > 0) return conflictInBranch(conflicted);

    // Squash-merge into main
    try {
      await gitExec(["merge", "--squash", mindName], { cwd: dir }, isolation);
    } catch (err) {
      const errOutput = [
        (err as Error).message,
        (err as Error & { stderr?: string }).stderr ?? "",
        (err as Error & { stdout?: string }).stdout ?? "",
      ].join("\n");
      const isConflict = errOutput.includes("CONFLICT") || errOutput.includes("could not apply");
      try {
        await gitExec(["reset", "--hard", "HEAD"], { cwd: dir }, isolation);
      } catch (resetErr: unknown) {
        console.error("[pages] reset after squash conflict failed", resetErr);
      }
      if (isConflict) {
        return { ok: false, conflicts: true, message: "Merge conflicts detected" };
      }
      return { ok: false, message: `Merge failed: ${(err as Error).message}` };
    }

    await gitExec(
      ["commit", "--author", `${mindName} <${mindName}@volute>`, "-m", message],
      { cwd: dir },
      isolation,
    );

    // Contributor bookkeeping for the caller's social events. Inside the lock on
    // purpose: HEAD is guaranteed to still be our squash commit.
    let changedFiles: string[] = [];
    const priorAuthors: Record<string, string[]> = {};
    try {
      changedFiles = (
        await gitExec(["diff", "--name-only", "HEAD^", "HEAD"], { cwd: dir }, isolation)
      )
        .trim()
        .split("\n")
        .filter(Boolean);
      for (const file of changedFiles) {
        const names = (
          await gitExec(["log", "--format=%an", "HEAD^", "--", file], { cwd: dir }, isolation)
        )
          .trim()
          .split("\n")
          .filter(Boolean);
        // "volute" is the committer identity used for the repo-init commit — not a mind.
        const unique = [...new Set(names)].filter((n) => n !== mindName && n !== "volute");
        if (unique.length > 0) priorAuthors[file] = unique;
      }
    } catch (err) {
      console.warn(`[pages] contributor lookup failed: ${(err as Error).message}`);
    }

    // Reset mind's branch to main
    try {
      await gitExec(["reset", "--hard", "main"], wt, isolation);
    } catch (err: unknown) {
      console.error(`[pages] branch reset failed for ${mindName}`, err);
      return {
        ok: true,
        message: "Published to main, but branch reset failed — run 'volute pages pull' to sync",
        changedFiles,
        priorAuthors,
      };
    }

    if (isolation?.isIsolationEnabled()) {
      try {
        await chownToMindTree(isolation, mindName, wt.cwd);
      } catch (err) {
        // Non-fatal: mind still functions but may hit permission errors
        console.warn(
          `[pages] failed to chown ${wt.cwd} for ${mindName}: ${(err as Error).message}`,
        );
      }
    }

    return { ok: true, changedFiles, priorAuthors };
  });
}

/** Recursively collect HTML and Markdown files in a directory, returning paths relative to baseDir. */
export function collectPageFiles(dir: string): string[] {
  const files: string[] = [];
  function walk(d: string) {
    let items: string[];
    try {
      items = readdirSync(d);
    } catch (err: any) {
      if (err?.code === "ENOENT") return;
      throw err;
    }
    for (const item of items) {
      if (item.startsWith(".")) continue;
      const full = resolve(d, item);
      try {
        const s = statSync(full);
        if (s.isFile() && (item.endsWith(".html") || item.endsWith(".md"))) {
          files.push(relative(dir, full));
        } else if (s.isDirectory()) {
          walk(full);
        }
      } catch (err: any) {
        if (err?.code === "ENOENT" || err?.code === "EACCES") continue;
        throw err;
      }
    }
  }
  walk(dir);
  return files.sort();
}

/** Whether a file path is a page file we track (HTML or Markdown). */
export function isPageFile(f: string): boolean {
  return f.endsWith(".html") || f.endsWith(".md");
}

/**
 * Whether the mind's pages/_system has changes a shared publish would send: uncommitted
 * edits, or commits main doesn't have. For plain publish to mention, since it never
 * sends them. False without asking git when there's no worktree there (a bare `_system`
 * dir would have git walk up into the mind's home repo), or when its gitdir can't be
 * vouched for: a `.git` the mind planted brings its own config, and git outside user
 * isolation runs as the daemon.
 */
export async function hasUnpublishedSharedChanges(
  mindName: string,
  mindDir: string,
  dataDir: string,
  isolation?: IsolationInfo,
): Promise<boolean> {
  if (!existsSync(resolve(worktreePath(mindDir), ".git"))) return false;
  try {
    const wt = await mindWorktree(mindName, mindDir, pagesRepoDir(dataDir), isolation);
    const status = await gitExec(["--no-optional-locks", "status", "--porcelain"], wt, isolation);
    if (status.trim()) return true;
    return !!(await gitExec(["diff", "--name-only", "main...HEAD"], wt, isolation)).trim();
  } catch (err) {
    log.warn("can't check pages/_system for unpublished changes", {
      mind: mindName,
      ...logger.errorData(err),
    });
    return false;
  }
}

/** Show files in the mind's shared pages worktree with draft/published status. */
export async function pagesStatus(
  mindName: string,
  mindDir: string,
  dataDir: string,
  isolation?: IsolationInfo,
): Promise<string> {
  const wt = await mindWorktree(mindName, mindDir, pagesRepoDir(dataDir), isolation);

  // Get files on main and files on the mind's branch (including uncommitted)
  const errors: Error[] = [];
  const [mainFiles, branchFiles, uncommitted] = await Promise.all([
    gitExec(["ls-tree", "-r", "--name-only", "main"], wt, isolation)
      .then((s) => s.trim().split("\n").filter(Boolean))
      .catch((err) => {
        errors.push(err);
        return [] as string[];
      }),
    gitExec(["ls-tree", "-r", "--name-only", "HEAD"], wt, isolation)
      .then((s) => s.trim().split("\n").filter(Boolean))
      .catch((err) => {
        errors.push(err);
        return [] as string[];
      }),
    gitExec(["status", "--porcelain"], wt, isolation)
      .then((s) => s.trim())
      .catch((err) => {
        errors.push(err);
        return "";
      }),
  ]);

  if (errors.length === 3) {
    throw new Error(`Shared pages git error: ${errors[0].message}`);
  }

  // Parse uncommitted files (new/modified)
  const uncommittedFiles = new Set<string>();
  if (uncommitted) {
    for (const line of uncommitted.split("\n")) {
      const match = line.match(/^.{2}\s+(.+)$/);
      if (match) uncommittedFiles.add(match[1]);
    }
  }

  const mainSet = new Set(mainFiles.filter(isPageFile));
  const allPageFiles = new Set([
    ...mainFiles.filter(isPageFile),
    ...branchFiles.filter(isPageFile),
    ...[...uncommittedFiles].filter(isPageFile),
  ]);

  if (allPageFiles.size === 0) return "No shared pages found.";

  const lines = [...allPageFiles].sort().map((file) => {
    const onMain = mainSet.has(file);
    const isUncommitted = uncommittedFiles.has(file);
    let status: string;
    if (isUncommitted) {
      status = "uncommitted";
    } else if (onMain) {
      status = "published";
    } else {
      status = "draft";
    }
    return `${status.padEnd(13)} ${file}`;
  });

  return lines.join("\n");
}

/** Show recent commit history on main, read from the repo, never a mind's worktree. */
export async function pagesLog(
  dataDir: string,
  limit = 20,
  isolation?: IsolationInfo,
): Promise<string> {
  const dir = pagesRepoDir(dataDir);
  const output = (
    await gitExec(["log", "--oneline", "main", `-${limit}`], { cwd: dir }, isolation)
  ).trim();
  return output || "No history.";
}
