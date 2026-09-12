import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  chownTargets,
  isIsolationEnabled,
  lockPrivateSubtrees,
  mindUserName,
  wrapForIsolation,
} from "../packages/daemon/src/lib/mind/isolation.js";
import { addMind, addVariant, removeMind } from "../packages/daemon/src/lib/mind/registry.js";

describe("isolation", () => {
  const originalEnv = process.env.VOLUTE_ISOLATION;
  const originalPrefix = process.env.VOLUTE_USER_PREFIX;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.VOLUTE_ISOLATION;
    } else {
      process.env.VOLUTE_ISOLATION = originalEnv;
    }
    if (originalPrefix === undefined) {
      delete process.env.VOLUTE_USER_PREFIX;
    } else {
      process.env.VOLUTE_USER_PREFIX = originalPrefix;
    }
  });

  it("isIsolationEnabled returns false by default", () => {
    delete process.env.VOLUTE_ISOLATION;
    assert.equal(isIsolationEnabled(), false);
  });

  it("isIsolationEnabled returns false for other values", () => {
    process.env.VOLUTE_ISOLATION = "none";
    assert.equal(isIsolationEnabled(), false);
  });

  it("isIsolationEnabled returns true when set to user", () => {
    process.env.VOLUTE_ISOLATION = "user";
    assert.equal(isIsolationEnabled(), true);
  });

  it("mindUserName prefixes with mind-", () => {
    assert.equal(mindUserName("alice"), "mind-alice");
    assert.equal(mindUserName("my-mind_1"), "mind-my-mind_1");
  });

  it("wrapForIsolation returns original cmd when isolation disabled", async () => {
    delete process.env.VOLUTE_ISOLATION;
    const [cmd, args] = await wrapForIsolation("/usr/bin/tsx", ["src/server.ts"], "alice");
    assert.equal(cmd, "/usr/bin/tsx");
    assert.deepEqual(args, ["src/server.ts"]);
  });

  it("wrapForIsolation wraps with runuser/sudo when isolation enabled", async () => {
    process.env.VOLUTE_ISOLATION = "user";
    const [cmd, args] = await wrapForIsolation(
      "/usr/bin/tsx",
      ["src/server.ts", "--port", "4100"],
      "alice",
    );
    const expectedCmd = process.platform === "darwin" ? "sudo" : "runuser";
    assert.equal(cmd, expectedCmd);
    assert.deepEqual(args, [
      "-u",
      "mind-alice",
      "--",
      "/usr/bin/tsx",
      "src/server.ts",
      "--port",
      "4100",
    ]);
  });

  it("wrapForIsolation uses base name for splits", async () => {
    process.env.VOLUTE_ISOLATION = "user";
    await addMind("alice", 4150);
    await addVariant("alice-experiment", "alice", 4151, "/fake", "experiment");
    const [cmd, args] = await wrapForIsolation("node", ["index.js"], "alice-experiment");
    const expectedCmd = process.platform === "darwin" ? "sudo" : "runuser";
    assert.equal(cmd, expectedCmd);
    assert.deepEqual(args, ["-u", "mind-alice", "--", "node", "index.js"]);
    await removeMind("alice");
  });

  it("wrapForIsolation respects VOLUTE_USER_PREFIX", async () => {
    process.env.VOLUTE_ISOLATION = "user";
    process.env.VOLUTE_USER_PREFIX = "volute-";
    const [cmd, args] = await wrapForIsolation("node", ["index.js"], "bob");
    const expectedCmd = process.platform === "darwin" ? "sudo" : "runuser";
    assert.equal(cmd, expectedCmd);
    assert.deepEqual(args, ["-u", "volute-bob", "--", "node", "index.js"]);
  });

  it("chownTargets skips only node_modules when it is already owned", async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "chown-narrow-"));
    mkdirSync(resolve(dir, "node_modules"));
    mkdirSync(resolve(dir, "home"));
    mkdirSync(resolve(dir, ".mind"));
    mkdirSync(resolve(dir, ".git"));
    mkdirSync(resolve(dir, "src"));
    // node_modules was just created by this process, so it's owned by us.
    const targets = await chownTargets(dir, userInfo().username);
    // Every top-level entry is recursed except the (already-owned) node_modules,
    // so root-created files (e.g. merge/upgrade git objects under .git) still get
    // re-chowned.
    assert.ok(!targets.includes(resolve(dir, "node_modules")), "node_modules should be skipped");
    assert.ok(targets.includes(resolve(dir, ".git")), ".git must be re-chowned");
    assert.deepEqual(
      [...targets].sort(),
      [
        resolve(dir, ".git"),
        resolve(dir, ".mind"),
        resolve(dir, "home"),
        resolve(dir, "src"),
      ].sort(),
    );
  });

  it("chownTargets recurses the whole dir when node_modules owner differs", async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "chown-owner-"));
    mkdirSync(resolve(dir, "node_modules"));
    mkdirSync(resolve(dir, "home"));
    const targets = await chownTargets(dir, "no-such-user-xyz-123");
    assert.deepEqual(targets, [dir]);
  });

  it("chownTargets recurses the whole dir when there is no node_modules", async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "chown-plain-"));
    mkdirSync(resolve(dir, "home"));
    const targets = await chownTargets(dir, userInfo().username);
    assert.deepEqual(targets, [dir]);
  });

  // A mind's session transcripts live under home/.claude/projects, created by the
  // Agent SDK as the mind user long after the daemon set 700 on the project root.
  // mkdtemp/mkdirSync modes are umask-filtered, so every dir here is chmod'ed to
  // 755 first — otherwise a 700 assertion could pass without the code running.
  const seedTree = (prefix: string, subdirs: string[]): string => {
    const dir = mkdtempSync(resolve(tmpdir(), prefix));
    chmodSync(dir, 0o755);
    for (const sub of subdirs) {
      mkdirSync(resolve(dir, sub), { recursive: true });
      chmodSync(resolve(dir, sub), 0o755);
    }
    return dir;
  };

  const mode = (path: string): number => statSync(path).mode & 0o777;

  // Subtrees come back symlink-resolved (macOS temp dirs sit under /var -> /private/var).
  const real = (dir: string, sub: string): string => realpathSync(resolve(dir, sub));

  it("lockPrivateSubtrees locks the root, .claude, projects and .mind to 700", async () => {
    const dir = seedTree("lock-private-", ["home/.claude/projects", ".mind", "home/.pi"]);
    // home/.claude is created as a parent of projects; pin its mode explicitly.
    chmodSync(resolve(dir, "home/.claude"), 0o755);
    const locked = await lockPrivateSubtrees(dir);
    assert.deepEqual(locked, [
      dir,
      real(dir, "home/.claude"),
      real(dir, "home/.claude/projects"),
      real(dir, ".mind"),
    ]);
    for (const p of locked) {
      assert.equal(mode(p), 0o700, `${p} should be 0700`);
    }
    // Only the mind's private subtrees are touched — not every dot-dir in home/.
    assert.ok(!locked.includes(resolve(dir, "home/.pi")), "home/.pi is not in the list");
    assert.equal(mode(resolve(dir, "home/.pi")), 0o755);
  });

  it("lockPrivateSubtrees skips subtrees that do not exist", async () => {
    const dir = seedTree("lock-partial-", ["home/.claude"]);
    const locked = await lockPrivateSubtrees(dir);
    assert.deepEqual(locked, [dir, real(dir, "home/.claude")]);
    assert.equal(mode(dir), 0o700);
    assert.equal(mode(resolve(dir, "home/.claude")), 0o700);
  });

  it("lockPrivateSubtrees refuses a private subtree replaced by a symlink", async () => {
    const dir = seedTree("lock-symlink-", ["home/.claude/projects"]);
    chmodSync(resolve(dir, "home/.claude"), 0o755);
    // A mind owns its own tree and can swap .mind for a link to anywhere. chmod
    // follows symlinks and the daemon is root, so following one here would lock
    // the link's target — `ln -s / .mind` would lock the host's filesystem.
    const elsewhere = seedTree("lock-symlink-target-", []);
    symlinkSync(elsewhere, resolve(dir, ".mind"));
    const locked = await lockPrivateSubtrees(dir);
    assert.deepEqual(locked, [dir, real(dir, "home/.claude"), real(dir, "home/.claude/projects")]);
    assert.equal(mode(elsewhere), 0o755, "the symlink's target must be left alone");
  });

  it("lockPrivateSubtrees refuses a root that is a symlink", async () => {
    const elsewhere = seedTree("lock-root-target-", []);
    const link = resolve(mkdtempSync(resolve(tmpdir(), "lock-root-link-")), "project");
    symlinkSync(elsewhere, link);
    assert.deepEqual(await lockPrivateSubtrees(link), []);
    assert.equal(mode(elsewhere), 0o755, "the symlink's target must be left alone");
  });

  it("lockPrivateSubtrees refuses subtrees reached through a swapped parent dir", async () => {
    // Only the last path component being a real directory is not enough: a mind
    // owns home/ too and can replace the whole thing with a link, so containment
    // has to hold for every component.
    const elsewhere = seedTree("lock-parent-target-", ["home/.claude/projects"]);
    chmodSync(resolve(elsewhere, "home/.claude"), 0o755);
    const dir = seedTree("lock-parent-", ["home"]);
    renameSync(resolve(dir, "home"), resolve(dir, "home.bak"));
    symlinkSync(resolve(elsewhere, "home"), resolve(dir, "home"));
    assert.deepEqual(await lockPrivateSubtrees(dir), [dir]);
    assert.equal(mode(resolve(elsewhere, "home/.claude")), 0o755, "outside dir untouched");
    assert.equal(mode(resolve(elsewhere, "home/.claude/projects")), 0o755, "outside dir untouched");
  });

  it("lockPrivateSubtrees sets modes through a handle, spawning no chmod", async () => {
    // The mode has to land on an inode this process opened, not on a path handed
    // to chmod(1): a path is check-then-act across a fork+exec, and the mind can
    // swap the directory for a symlink inside that window and have root follow
    // it. Proven by putting a fake `chmod` first on PATH — if one is ever
    // spawned, it leaves a marker.
    const shim = mkdtempSync(resolve(tmpdir(), "lock-shim-"));
    const marker = resolve(shim, "chmod-was-spawned");
    writeFileSync(resolve(shim, "chmod"), `#!/bin/sh\ntouch ${marker}\nexit 0\n`);
    chmodSync(resolve(shim, "chmod"), 0o755);
    const dir = seedTree("lock-nospawn-", ["home/.claude/projects", ".mind"]);
    chmodSync(resolve(dir, "home/.claude"), 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = `${shim}:${originalPath ?? ""}`;
    try {
      const locked = await lockPrivateSubtrees(dir);
      assert.equal(locked.length, 4, "every private dir is still locked");
      for (const p of locked) assert.equal(mode(p), 0o700, `${p} should be 0700`);
    } finally {
      process.env.PATH = originalPath;
    }
    assert.ok(!existsSync(marker), "no chmod subprocess may be spawned");
  });

  it("lockPrivateSubtrees locks a bare dir with no subtrees", async () => {
    const dir = seedTree("lock-bare-", []);
    assert.deepEqual(await lockPrivateSubtrees(dir), [dir]);
    assert.equal(mode(dir), 0o700);
  });
});
