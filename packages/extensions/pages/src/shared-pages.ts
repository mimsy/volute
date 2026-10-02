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
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { chownTree } from "@volute/daemon/lib/util/chown-tree.js";
import { buildMindBaseEnv } from "@volute/daemon/lib/util/mind-env.js";
import { isMultiplyLinkedFile } from "./ownership.js";

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
 * isolation, with `home` as its HOME; see `mindWorktree`.
 */
type GitOpts = { cwd: string; asMind?: { name: string; home: string } };

/**
 * How long one git command may run. A mind owns its gitdir under `.git/worktrees/`,
 * and root's `worktree prune`, `branch -D` and checked-out-branch checks read every
 * gitdir there: a FIFO planted in one would otherwise hang the command, and the
 * pages lock it holds, forever.
 */
const GIT_TIMEOUT_MS = 120_000;

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
  }
  return new Promise((resolve, reject) => {
    const execOpts = { cwd: opts.cwd, env, timeout: GIT_TIMEOUT_MS };
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
function readPointerFile(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > 4096) throw new Error(`${path} is not a git pointer file`);
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
 * not the mind's tree) must lead back to this worktree. `worktree` is the
 * worktree's contained path.
 */
export function worktreeGitDir(repoDir: string, worktree: string): string | null {
  try {
    const realWorktree = realpathSync(worktree);
    const match = readPointerFile(resolve(realWorktree, ".git")).match(/^gitdir:\s*(.+)$/);
    if (!match) return null;
    const gitDir = realpathSync(resolve(realWorktree, match[1]));
    if (dirname(gitDir) !== realpathSync(resolve(repoDir, ".git", "worktrees"))) return null;
    // Relative under git's worktree.useRelativePaths, and then relative to the gitdir.
    const back = resolve(gitDir, readPointerFile(resolve(gitDir, "gitdir")));
    if (realpathSync(dirname(back)) !== realWorktree) return null;
    return gitDir;
  } catch (err) {
    console.warn(`[pages] can't resolve the gitdir of ${worktree}: ${(err as Error).message}`);
    return null;
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
 * any filter driver or other program that config names. Throws if containment
 * refuses, or if the worktree isn't there.
 */
async function mindWorktree(
  mindName: string,
  mindDir: string,
  isolation?: IsolationInfo,
): Promise<GitOpts> {
  const wt = worktreePath(mindDir);
  if (!isolation?.isIsolationEnabled()) return { cwd: wt };
  return {
    cwd: await isolation.containMindPath(mindName, wt),
    asMind: { name: mindName, home: resolve(mindDir, "home") },
  };
}

/** What a mind is told when its worktree can't be contained. */
function refusedWorktree(mindName: string, err: unknown): { ok: false; message: string } {
  console.warn(`[pages] refused ${mindName}'s worktree: ${(err as Error).message}`);
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
 * anything that isn't a `dir`/file the daemon owns.
 */
function setDaemonMode(path: string, mode: number, dir: boolean): void {
  const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  const fd = openSync(path, dir ? flags | constants.O_DIRECTORY : flags);
  try {
    const st = fstatSync(fd);
    if ((dir ? !st.isDirectory() : !st.isFile()) || st.uid !== process.getuid?.()) {
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
]);

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
 * - the work tree, `.git`, `hooks/`, `info/` and `worktrees/` go to 2755. They are
 *   not group-writable at all, so no sticky bit is needed for a mind to be unable
 *   to rename `config` away or replace another mind's gitdir;
 * - `config` and `HEAD` go to 0644, and `config` keeps only the keys `git init` writes;
 * - an entry in `hooks/` or `info/` the daemon doesn't own is removed, and the rest
 *   lose group write;
 * - `commondir`, `gitdir` and `config.worktree` in `.git` are removed: a main repo
 *   never has them, and each would change where git reads config from.
 *
 * Runs at every daemon start, so it also repairs installs from before it existed.
 * Throws if `.git`, one of those directories, `config` or `HEAD` is not the daemon's
 * own: the repo can't be trusted, and the caller re-initializes it.
 */
export async function hardenPagesRepo(dir: string): Promise<void> {
  const gitDir = resolve(dir, ".git");
  setDaemonMode(dir, 0o2755, true);
  setDaemonMode(gitDir, 0o2755, true);
  for (const sub of ["hooks", "info", "worktrees"]) {
    const path = resolve(gitDir, sub);
    mkdirSync(path, { recursive: true });
    setDaemonMode(path, 0o2755, true);
  }
  for (const file of ["config", "HEAD"]) setDaemonMode(resolve(gitDir, file), 0o644, false);
  for (const name of ["commondir", "gitdir", "config.worktree"]) {
    rmSync(resolve(gitDir, name), { recursive: true, force: true });
  }
  for (const sub of ["hooks", "info"]) {
    for (const name of readdirSync(resolve(gitDir, sub))) {
      const path = resolve(gitDir, sub, name);
      const st = lstatSync(path);
      if (st.isFile() && st.uid === process.getuid?.()) chmodSync(path, st.mode & 0o755);
      else rmSync(path, { recursive: true, force: true });
    }
  }

  // Read and edited as a plain file, never as a repo's config: no include followed.
  const config = resolve(gitDir, "config");
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

  if (existsSync(resolve(dir, ".git"))) {
    let trusted = true;
    try {
      await hardenPagesRepo(dir);
    } catch (err) {
      console.warn(`[pages] repo tampered with: ${(err as Error).message}`);
      trusted = false;
    }
    if (trusted && (await isRepoValid(dir, isolation))) return;
    // Any invalid or incomplete state — a husk .git from an interrupted init, or
    // a repo with no commits — is wiped and re-initialized. The repo's content
    // is regenerable (it's synced from minds' pages), so aggressive re-init is
    // safe, and it self-heals boxes stuck with a broken repo on next daemon start.
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
  await hardenPagesRepo(dir);
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

  const wt = resolve(pages, "_system");
  if (existsSync(wt)) {
    // A real worktree has a `.git` file. A plain directory here is what a mind
    // creates by hand when publishing failed for lack of a worktree (#795) — say
    // so, because git then refuses to provision over it and every later publish
    // fails with an opaque `invalid upstream` deep inside the rebase.
    if (!existsSync(resolve(wt, ".git"))) {
      console.warn(
        `[pages] ${wt} exists but is not a worktree — shared publishing will fail for ${mindName}. Move it aside and restart the mind to provision one.`,
      );
    }
    return;
  }

  let branchExists = false;
  try {
    await gitExec(["rev-parse", "--verify", mindName], { cwd: dir }, isolation);
    branchExists = true;
  } catch {
    // branch doesn't exist
  }

  if (branchExists) {
    await gitExec(["worktree", "add", wt, mindName], { cwd: dir }, isolation);
  } else {
    await gitExec(["worktree", "add", "-b", mindName, wt], { cwd: dir }, isolation);
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
    wt = (await mindWorktree(mindName, mindDir, isolation)).cwd;
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

/**
 * Commit whatever the mind has left uncommitted in its worktree, or refuse.
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
async function commitPendingChanges(
  mindName: string,
  git: GitOpts,
  isolation?: IsolationInfo,
): Promise<{ ok: false; message: string } | null> {
  const linked = await findMultiplyLinkedFiles(git, isolation);
  if (linked.length > 0) {
    console.warn(
      `[pages] refused to commit ${mindName}'s worktree: hard-linked ${linked.join(", ")}`,
    );
    const list = linked.map((f) => `  ${f}`).join("\n");
    return {
      ok: false,
      message:
        `Nothing was committed. These files in pages/_system have a second name on disk (a hard link):\n${list}\n` +
        "Shared pages are committed by the daemon, which reads a file's contents with its own privileges, " +
        "so a hard-linked file can't be published. Replace each with an ordinary copy " +
        "(e.g. `cp <file> <file>.tmp && mv <file>.tmp <file>`) and try again.",
    };
  }

  const status = (await gitExec(["status", "--porcelain"], git, isolation)).trim();
  if (status) {
    await gitExec(["add", "-A"], git, isolation);
    await gitExec(
      ["commit", "--author", `${mindName} <${mindName}@volute>`, "-m", `wip: ${mindName}`],
      git,
      isolation,
    );
  }
  return null;
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
      wt = await mindWorktree(mindName, mindDir, isolation);
    } catch (err) {
      return refusedWorktree(mindName, err);
    }

    const refused = await commitPendingChanges(mindName, wt, isolation);
    if (refused) return refused;

    // Check if there's anything to merge
    const diff = (
      await gitExec(["diff", `main...${mindName}`, "--stat"], { cwd: dir }, isolation)
    ).trim();
    if (!diff) {
      return { ok: true, message: "Nothing to publish" };
    }

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
  isolation?: IsolationInfo,
): Promise<{ ok: boolean; conflicts?: boolean; message?: string }> {
  return withPagesLock(async () => {
    let wt: GitOpts;
    try {
      wt = await mindWorktree(mindName, mindDir, isolation);
    } catch (err) {
      return refusedWorktree(mindName, err);
    }

    const refused = await commitPendingChanges(mindName, wt, isolation);
    if (refused) return refused;

    // Rebase onto main
    try {
      await gitExec(["rebase", "main"], wt, isolation);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const isConflict =
        errMsg.includes("CONFLICT") ||
        errMsg.includes("could not apply") ||
        errMsg.includes("merge conflict");

      try {
        await gitExec(["rebase", "--abort"], wt, isolation);
      } catch (abortErr: unknown) {
        console.error("[pages] rebase abort failed", abortErr);
      }

      if (isConflict) {
        return {
          ok: false,
          conflicts: true,
          message:
            "Pull conflicts detected — your changes conflict with main. Reconcile the conflicting files, commit, and pull again.",
        };
      }

      console.error("[pages] pull rebase failed", err);
      return { ok: false, message: `Pull failed: ${errMsg}` };
    }

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
      wt = await mindWorktree(mindName, mindDir, isolation);
    } catch (err) {
      return refusedWorktree(mindName, err);
    }

    // Commit pending changes once (shared by pull and merge)
    const refused = await commitPendingChanges(mindName, wt, isolation);
    if (refused) return refused;

    // Rebase onto main (pull)
    try {
      await gitExec(["rebase", "main"], wt, isolation);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const isConflict =
        errMsg.includes("CONFLICT") ||
        errMsg.includes("could not apply") ||
        errMsg.includes("merge conflict");

      try {
        await gitExec(["rebase", "--abort"], wt, isolation);
      } catch (abortErr: unknown) {
        console.error("[pages] rebase abort failed", abortErr);
      }

      if (isConflict) {
        return {
          ok: false,
          conflicts: true,
          message:
            "Pull conflicts detected — your changes conflict with main. Reconcile the conflicting files, commit, and try again.",
        };
      }
      return { ok: false, message: `Pull failed: ${errMsg}` };
    }

    // Check if there's anything to merge
    const diff = (
      await gitExec(["diff", `main...${mindName}`, "--stat"], { cwd: dir }, isolation)
    ).trim();
    if (!diff) {
      return { ok: true, message: "Nothing to publish" };
    }

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

/** Show files in the mind's shared pages worktree with draft/published status. */
export async function pagesStatus(
  mindName: string,
  mindDir: string,
  isolation?: IsolationInfo,
): Promise<string> {
  const wt = await mindWorktree(mindName, mindDir, isolation);

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

/** Show recent commit history on main. */
export async function pagesLog(
  mindName: string,
  mindDir: string,
  limit = 20,
  isolation?: IsolationInfo,
): Promise<string> {
  const wt = await mindWorktree(mindName, mindDir, isolation);
  const output = (await gitExec(["log", "--oneline", "main", `-${limit}`], wt, isolation)).trim();
  return output || "No history.";
}
