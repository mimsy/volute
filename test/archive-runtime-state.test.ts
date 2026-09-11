import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { resolve } from "node:path";
import { after, describe, it } from "node:test";
import { createExportArchive } from "../packages/daemon/src/lib/mind/archive.js";
import { mindDir, stateDir } from "../packages/daemon/src/lib/mind/registry.js";
import {
  applyInitFiles,
  composeTemplate,
  copyTemplateToDir,
  findTemplatesRoot,
} from "../packages/daemon/src/lib/template/template.js";

/**
 * An export is how a mind moves between hosts with its self intact, and it has
 * to work on the mind as it actually is: running, and carrying the runtime
 * droppings the template's `.gitignore` exists to keep out.
 *
 * Two things went wrong on the 0.60.1 integration test. A running mind could not
 * be exported at all, because the SDK leaves unix sockets under `.mind/tmp` and
 * `readFileSync` on one throws ENXIO (#1058). And on every `isolation: user`
 * install git refused the mind's repo as "dubious ownership", so the fallback
 * directory walk ran, honoured no `.gitignore` rule, and swept the mind's npm
 * cache into a 150 MB archive (#1059).
 */

const mindNames: string[] = [];
const servers: Server[] = [];

function freshMind(name: string): string {
  mindNames.push(name);
  const dir = mindDir(name);
  mkdirSync(resolve(dir, "home/.config"), { recursive: true });
  writeFileSync(resolve(dir, "home/SOUL.md"), "# Soul\n");
  writeFileSync(resolve(dir, "home/.config/volute.json"), "{}\n");
  return dir;
}

/** A mind directory composed from the real template, `.gitignore` included. */
function composedMind(name: string): string {
  mindNames.push(name);
  const dir = mindDir(name);
  const { composedDir, manifest } = composeTemplate(findTemplatesRoot(), "claude");
  try {
    copyTemplateToDir(composedDir, dir, name, manifest);
    applyInitFiles(dir);
  } finally {
    rmSync(composedDir, { recursive: true, force: true });
  }
  return dir;
}

function listen(path: string): Promise<Server> {
  return new Promise((ok, fail) => {
    const server = createServer();
    servers.push(server);
    server.once("error", fail);
    server.listen(path, () => ok(server));
  });
}

type Opts = { includeSrc?: boolean; includeSessions?: boolean; includeEnv?: boolean };

function entriesOf(name: string, opts: Opts = {}): string[] {
  return createExportArchive({ name, template: "claude", ...opts })
    .getEntries()
    .map((e) => e.entryName);
}

after(() => {
  for (const server of servers) server.close();
  for (const name of mindNames) {
    rmSync(mindDir(name), { recursive: true, force: true });
    rmSync(stateDir(name), { recursive: true, force: true });
  }
});

describe("exporting a running mind (#1058)", () => {
  for (const includeSrc of [false, true]) {
    const label = includeSrc ? "a full export" : "a home-only export";

    it(`${label} skips the SDK's sockets and the mind's tmp dir`, async () => {
      // Short name: a unix socket path is capped at 104 bytes on macOS.
      const name = `sock-${includeSrc ? "full" : "home"}`;
      const dir = freshMind(name);
      mkdirSync(resolve(dir, ".mind/tmp/cc-socks"), { recursive: true });

      // The socket sits outside `.mind/tmp` so that only the regular-file guard
      // hides it; a plain file inside `.mind/tmp` pins the tmp exclusion on its
      // own. Either guard alone would hide a socket under `.mind/tmp`.
      const sock = resolve(dir, ".mind/live.sock");
      assert.ok(sock.length < 100, `socket path too long for sun_path: ${sock}`);
      await listen(sock);
      writeFileSync(resolve(dir, ".mind/tmp/cc-socks/813.txt"), "scratch\n");
      writeFileSync(resolve(dir, ".mind/keep.json"), "{}\n");
      // Judged by lstat: following this one would throw ENOENT before any read.
      symlinkSync(resolve(dir, ".mind/gone"), resolve(dir, ".mind/dangling"));

      const entries = entriesOf(name, { includeSrc });

      assert.ok(entries.includes("mind/.mind/keep.json"), "regular .mind files still export");
      assert.ok(!entries.includes("mind/.mind/live.sock"), "a socket must not be archived");
      assert.ok(!entries.includes("mind/.mind/dangling"), "a symlink is not a regular file");
      assert.ok(
        !entries.some((e) => e.startsWith("mind/.mind/tmp/")),
        "the mind's TMPDIR is scratch space, none of it belongs in an archive",
      );
    });
  }
});

describe("keeping runtime caches out of the archive (#1059)", () => {
  it("applies the mind's .gitignore even when git would refuse the repo as dubiously owned", () => {
    const name = "dubious-owner";
    const dir = composedMind(name);
    execFileSync("git", ["init", "-q"], { cwd: dir });
    // Ignored by the template's `home/*` rule and by nothing else: only the git
    // branch of the export can keep this out, so its absence proves that branch
    // ran despite the ownership refusal.
    writeFileSync(resolve(dir, "home/scratch.txt"), "not identity\n");

    // Git's own test suite uses this to make every repo look owned by someone
    // else — the same refusal `isolation: user` produces when the host exports
    // a mind owned by `mind-<name>`.
    //
    // The assertion below is the fixture's own tripwire, and it earns its keep
    // twice: it goes red if git ever drops the knob, and it catches the machine
    // where a global `safe.directory = *` would make this test pass with the fix
    // reverted.
    process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER = "1";
    try {
      assert.throws(
        () => execFileSync("git", ["ls-files"], { cwd: dir, stdio: "pipe" }),
        /dubious ownership/,
        "the fixture must reproduce the refusal it claims to",
      );

      const entries = entriesOf(name);
      assert.ok(entries.includes("mind/home/SOUL.md"));
      assert.ok(
        !entries.includes("mind/home/scratch.txt"),
        "the .gitignore must apply: git was refused the repo and the walk ran instead",
      );
    } finally {
      delete process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER;
    }
  });

  it("never sweeps toolchain caches into a non-git mind's export", () => {
    const name = "cache-nogit";
    const dir = freshMind(name);
    mkdirSync(resolve(dir, "home/.npm/_cacache"), { recursive: true });
    writeFileSync(resolve(dir, "home/.npm/_cacache/blob"), "x".repeat(1024));
    mkdirSync(resolve(dir, "home/.claude/projects/-home"), { recursive: true });
    writeFileSync(resolve(dir, "home/.claude/projects/-home/session.jsonl"), "{}\n");
    mkdirSync(resolve(dir, "home/.claude/skills/memory"), { recursive: true });
    writeFileSync(resolve(dir, "home/.claude/skills/memory/SKILL.md"), "# memory\n");

    const entries = entriesOf(name);

    assert.ok(entries.includes("mind/home/SOUL.md"));
    assert.ok(entries.includes("mind/home/.claude/skills/memory/SKILL.md"), "skills still export");
    assert.ok(!entries.some((e) => e.startsWith("mind/home/.npm/")), "npm cache");
    assert.ok(!entries.some((e) => e.startsWith("mind/home/.claude/projects/")), "SDK transcripts");
  });

  it("never runs a command the mind named in its own git config", () => {
    // `core.fsmonitor` is a config key whose value git *executes*, on every read
    // of the index — so both `ls-files` calls reach it. The mind owns
    // `.git/config`, and on a system install the export runs as root: without
    // the `-c core.fsmonitor=false` pin, lifting the ownership refusal would
    // have handed a mind a root shell on the host that exports it.
    const name = "fsmonitor-exec";
    const dir = composedMind(name);
    execFileSync("git", ["init", "-q"], { cwd: dir });
    const marker = resolve(dir, "FSMONITOR_RAN");
    appendFileSync(
      resolve(dir, ".git/config"),
      `\n[core]\n\tfsmonitor = "touch ${marker}; echo 1"\n`,
    );

    entriesOf(name);

    assert.ok(!existsSync(marker), "a mind's core.fsmonitor must never be executed by the export");
  });

  it("keeps them out even when the mind un-ignores them in its own .gitignore", () => {
    // The template's `.gitignore` covers most of this set on the git branch, but
    // that file sits in the mind's own writable tree — so a guarantee that rests
    // on it is revocable by the untrusted party it constrains.
    const name = "unignored-cache";
    const dir = composedMind(name);
    appendFileSync(resolve(dir, ".gitignore"), "\n!home/.npm/\n!home/.npm/**\n");
    execFileSync("git", ["init", "-q"], { cwd: dir });
    mkdirSync(resolve(dir, "home/.npm/_cacache"), { recursive: true });
    writeFileSync(resolve(dir, "home/.npm/_cacache/blob"), "x".repeat(1024));

    const entries = entriesOf(name);

    assert.ok(entries.includes("mind/home/SOUL.md"));
    assert.ok(
      !entries.some((e) => e.startsWith("mind/home/.npm/")),
      "git listed the cache because the mind said to; the export still must not carry it",
    );
  });

  it("keeps an un-ignored dependency tree out too", () => {
    // EXCLUDED_DIRS was enforced only inside the walk, so the one directory
    // EXCLUDED_PATHS does not name was the one a mind could re-admit by editing
    // its own .gitignore — for a project it created for itself.
    const name = "unignored-modules";
    const dir = composedMind(name);
    appendFileSync(resolve(dir, ".gitignore"), "\n!home/app/\n!home/app/**\n");
    execFileSync("git", ["init", "-q"], { cwd: dir });
    mkdirSync(resolve(dir, "home/app/node_modules/left-pad"), { recursive: true });
    writeFileSync(resolve(dir, "home/app/node_modules/left-pad/index.js"), "x".repeat(1024));
    writeFileSync(resolve(dir, "home/app/index.js"), "// the mind's own code\n");

    const entries = entriesOf(name);

    assert.ok(entries.includes("mind/home/app/index.js"), "the mind's own project travels");
    assert.ok(
      !entries.some((e) => e.includes("node_modules")),
      "a dependency tree is rehydrated from a lockfile, never archived",
    );
  });

  for (const git of [true, false]) {
    it(`keeps home/.local toolchain dirs out of ${git ? "a git" : "a non-git"} export`, () => {
      // `home/.local/` is walked explicitly on both branches so the mind's hooks
      // travel (#1013); the XDG data/state/lib dirs beside them must not.
      const name = `local-share-${git ? "git" : "nogit"}`;
      const dir = git ? composedMind(name) : freshMind(name);
      if (git) execFileSync("git", ["init", "-q"], { cwd: dir });
      mkdirSync(resolve(dir, "home/.local/hooks"), { recursive: true });
      writeFileSync(resolve(dir, "home/.local/hooks/mine.sh"), "#!/bin/sh\n");
      mkdirSync(resolve(dir, "home/.local/share/uv/tools"), { recursive: true });
      writeFileSync(resolve(dir, "home/.local/share/uv/tools/bin"), "x".repeat(1024));

      const entries = entriesOf(name);

      assert.ok(entries.includes("mind/home/.local/hooks/mine.sh"), "the mind's hooks travel");
      assert.ok(!entries.some((e) => e.startsWith("mind/home/.local/share/")), "XDG data dir");
    });
  }
});

describe("symlinks a mind planted in its own home (#1058)", () => {
  it("does not follow one git reports, whether it points at a directory or a host file", () => {
    // The git branch is the one this fix newly activates on production installs,
    // and `git ls-files --others` reports symlinks (it skips only sockets and
    // FIFOs). `home/memory/**` is un-ignored by the template's `.gitignore`, so
    // a mind can plant one there: pointed at a directory the old read threw
    // EISDIR and killed the export, pointed at a host file it archived the file.
    const name = "home-symlink";
    const dir = composedMind(name);
    execFileSync("git", ["init", "-q"], { cwd: dir });
    const secret = resolve(dir, "..", `${name}-outside-secret`);
    writeFileSync(secret, "host secret\n");
    mkdirSync(resolve(dir, "home/memory/real"), { recursive: true });
    writeFileSync(resolve(dir, "home/memory/real/note.md"), "# note\n");
    symlinkSync(resolve(dir, "home/memory/real"), resolve(dir, "home/memory/to-dir"));
    symlinkSync(secret, resolve(dir, "home/memory/to-file"));

    try {
      const entries = entriesOf(name);

      assert.ok(entries.includes("mind/home/memory/real/note.md"), "real files still export");
      assert.ok(!entries.includes("mind/home/memory/to-dir"), "a symlink to a directory");
      assert.ok(!entries.includes("mind/home/memory/to-file"), "a symlink to a host file");
    } finally {
      rmSync(secret, { force: true });
    }
  });

  it("refuses a walked subtree whose root the mind replaced with a symlink", () => {
    // `home/.local/` is walked in explicitly on both branches (#1013), and
    // `readdirSync` follows a symlink — so without a root check a mind could
    // point it at /minds and have the export read every other mind's files,
    // as whoever ran the export, which on a system install is root.
    const name = "local-symlink";
    const dir = freshMind(name);
    const outside = resolve(dir, "..", `${name}-outside`);
    mkdirSync(resolve(outside, "nested"), { recursive: true });
    writeFileSync(resolve(outside, "nested/other-mind.md"), "not ours\n");
    symlinkSync(outside, resolve(dir, "home/.local"));

    try {
      const entries = entriesOf(name);

      assert.ok(entries.includes("mind/home/SOUL.md"), "the mind's own files still export");
      assert.ok(
        !entries.some((e) => e.includes("other-mind.md")),
        "nothing from outside the mind dir may be archived",
      );
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("a host's own symlinked mind directory", () => {
  it("still exports, rather than being refused as a symlinked root", () => {
    // The walks refuse a symlinked root because a mind can plant one. A host
    // may equally have parked a mind dir elsewhere and symlinked it into place,
    // and that must keep working: the export resolves the mind dir once, up
    // front, so only the subtrees the mind itself controls are judged.
    const name = "linked-mind";
    const real = resolve(mindDir(name), "..", `${name}-real`);
    mkdirSync(resolve(real, "home"), { recursive: true });
    writeFileSync(resolve(real, "home/SOUL.md"), "# Soul\n");
    mindNames.push(name);
    symlinkSync(real, mindDir(name));

    try {
      const entries = entriesOf(name, { includeSrc: true });
      assert.ok(entries.includes("mind/home/SOUL.md"), "a symlinked mind dir is the host's doing");
    } finally {
      rmSync(mindDir(name), { force: true });
      rmSync(real, { recursive: true, force: true });
    }
  });
});

describe("everything else an export opens (#1058)", () => {
  it("does not enumerate a .mind/sessions the mind pointed somewhere else", () => {
    const name = "sessions-dir-symlink";
    const dir = freshMind(name);
    const elsewhere = resolve(dir, "..", `${name}-elsewhere`);
    mkdirSync(elsewhere, { recursive: true });
    writeFileSync(resolve(elsewhere, "not-ours.json"), "{}\n");
    mkdirSync(resolve(dir, ".mind"), { recursive: true });
    symlinkSync(elsewhere, resolve(dir, ".mind/sessions"));

    try {
      assert.ok(
        !entriesOf(name, { includeSessions: true }).some((e) => e.startsWith("sessions/")),
        "a redirected sessions dir must contribute nothing",
      );
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("does not follow a symlink the mind left in .mind/sessions", () => {
    // `--include-sessions` bundles `.mind/sessions/*.json` from a directory the
    // mind owns outright. A FIFO there would hang the export for good; this
    // stands in for it, because a test that hangs proves nothing twice.
    const name = "sessions-symlink";
    const dir = freshMind(name);
    const secret = resolve(dir, "..", `${name}-outside.json`);
    writeFileSync(secret, '{"host":"secret"}\n');
    mkdirSync(resolve(dir, ".mind/sessions"), { recursive: true });
    writeFileSync(resolve(dir, ".mind/sessions/main.json"), "{}\n");
    symlinkSync(secret, resolve(dir, ".mind/sessions/stolen.json"));

    try {
      const entries = entriesOf(name, { includeSessions: true });

      assert.ok(entries.includes("sessions/main.json"), "real session files still travel");
      assert.ok(!entries.includes("sessions/stolen.json"), "a symlink out of the mind dir");
    } finally {
      rmSync(secret, { force: true });
    }
  });

  it("does not follow a symlink the mind left at its own state/env.json", () => {
    // The state dir is chowned to `mind-<name>` on a system install, so env.json
    // is as replaceable as anything in the mind dir — and the import writes what
    // the archive carries straight back into the new host's state dir.
    const name = "env-symlink";
    const dir = freshMind(name);
    const secret = resolve(dir, "..", `${name}-outside-env.json`);
    writeFileSync(secret, '{"HOST_SECRET":"x"}\n');
    mkdirSync(stateDir(name), { recursive: true });
    symlinkSync(secret, resolve(stateDir(name), "env.json"));

    try {
      assert.ok(
        !entriesOf(name, { includeEnv: true }).includes("state/env.json"),
        "a symlinked env.json must not be read on the host's behalf",
      );
    } finally {
      rmSync(secret, { force: true });
    }
  });
});

describe("what a mind may name its own files (#1059)", () => {
  it("exports memory files whose names are not ASCII, or contain a newline", () => {
    // git C-quotes non-ASCII paths by default, so `ls-files` hands back a name
    // that does not exist on disk and the file drops out of the archive without
    // a word. Only reachable since the git branch started running in production.
    const name = "unicode-names";
    const dir = composedMind(name);
    execFileSync("git", ["init", "-q"], { cwd: dir });
    mkdirSync(resolve(dir, "home/memory"), { recursive: true });
    writeFileSync(resolve(dir, "home/memory/café-📓.md"), "# journal\n");
    writeFileSync(resolve(dir, "home/memory/two\nlines.md"), "# journal\n");

    const entries = entriesOf(name);

    assert.ok(
      entries.includes("mind/home/memory/café-📓.md"),
      "git C-quotes a non-ASCII path unless the listing is NUL-separated",
    );
    assert.ok(
      entries.includes("mind/home/memory/two\nlines.md"),
      "a newline in a name splits one line-separated listing entry into two",
    );
  });

  it("enumerates the mind's tree, not one its git config points at", () => {
    // A mind that writes `core.worktree` into its own `.git/config` redirects
    // the listing wholesale; pointed at `/` it makes the export walk the entire
    // host filesystem as root and then fail into the #1059 fallback.
    const name = "worktree-redirect";
    const dir = composedMind(name);
    execFileSync("git", ["init", "-q"], { cwd: dir });
    const elsewhere = resolve(dir, "..", `${name}-elsewhere`);
    mkdirSync(resolve(elsewhere, "home"), { recursive: true });
    writeFileSync(resolve(elsewhere, "home/NOT-OURS.md"), "elsewhere\n");
    execFileSync("git", ["config", "core.worktree", elsewhere], { cwd: dir });

    try {
      const entries = entriesOf(name);

      assert.ok(entries.includes("mind/home/SOUL.md"), "the mind's own home is what travels");
      assert.ok(!entries.some((e) => e.includes("NOT-OURS.md")), "a redirected work tree");
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});

describe("what a mind may put in its own git index (#1059)", () => {
  it("archives nothing outside the mind dir, whatever ls-files reports", () => {
    // `.git/index` is the mind's own file. `update-index` and `read-tree` both
    // refuse a `..` component, but nothing re-validates an index written
    // directly — which any mind with a shell can do — and `ls-files` then prints
    // the path verbatim. It passes a prefix test for `home/`, and `resolve()`
    // walks it out of the mind dir into a file the exporting host can read.
    // Newly reachable: lifting the ownership refusal is what makes this branch
    // run at all under `isolation: user`.
    const name = "index-traversal";
    const dir = composedMind(name);
    execFileSync("git", ["init", "-q"], { cwd: dir });
    const secret = resolve(dir, "..", `${name}-HOST-SECRET.txt`);
    writeFileSync(secret, "host secret\n");
    const blob = execFileSync("git", ["hash-object", "-w", "home/SOUL.md"], {
      cwd: dir,
      encoding: "utf-8",
    }).trim();
    writeIndexWithPaths(resolve(dir, ".git/index"), blob, [
      `home/../../${name}-HOST-SECRET.txt`,
      "home/SOUL.md",
    ]);

    try {
      assert.match(
        execFileSync("git", ["ls-files"], { cwd: dir, encoding: "utf-8" }),
        /HOST-SECRET/,
        "the fixture must reproduce the traversal it claims to",
      );

      const entries = entriesOf(name);

      assert.ok(entries.includes("mind/home/SOUL.md"), "real entries still export");
      assert.ok(
        !entries.some((e) => e.includes("HOST-SECRET")),
        "a path that escapes the mind dir must never be read into the archive",
      );
    } finally {
      rmSync(secret, { force: true });
    }
  });

  it("archives nothing reached through a symlinked parent directory", () => {
    // Lexical containment normalises `..` but cannot see a symlink in the
    // middle: `home/memory/esc` pointing at a host directory makes
    // `home/memory/esc/shadow.txt` lexically inside the mind dir, and the file
    // it names really is a regular file, so no later check objects.
    const name = "intermediate-symlink";
    const dir = composedMind(name);
    execFileSync("git", ["init", "-q"], { cwd: dir });
    const outside = resolve(dir, "..", `${name}-outside`);
    mkdirSync(outside, { recursive: true });
    writeFileSync(resolve(outside, "shadow.txt"), "host secret\n");
    mkdirSync(resolve(dir, "home/memory"), { recursive: true });
    symlinkSync(outside, resolve(dir, "home/memory/esc"));
    const blob = execFileSync("git", ["hash-object", "-w", "home/SOUL.md"], {
      cwd: dir,
      encoding: "utf-8",
    }).trim();
    writeIndexWithPaths(resolve(dir, ".git/index"), blob, [
      "home/memory/esc/shadow.txt",
      "home/SOUL.md",
    ]);

    try {
      assert.match(
        execFileSync("git", ["ls-files"], { cwd: dir, encoding: "utf-8" }),
        /esc\/shadow\.txt/,
        "the fixture must reproduce the listing it claims to",
      );

      const entries = entriesOf(name);

      assert.ok(entries.includes("mind/home/SOUL.md"), "real entries still export");
      assert.ok(
        !entries.some((e) => e.includes("shadow.txt")),
        "a path whose parent resolves outside the mind dir must not be read",
      );
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("an export that cannot read what it found", () => {
  it("fails rather than quietly shipping an archive with the file missing", () => {
    // EACCES means the file is there and could not be opened. Skipping it makes
    // a short archive that exits 0 and looks complete — the mind arrives on the
    // new host with pieces gone and nobody knows to look.
    if (process.getuid?.() === 0) return; // root reads everything

    const name = "unreadable-file";
    const dir = freshMind(name);
    const locked = resolve(dir, "home/locked.md");
    writeFileSync(locked, "# secret\n");
    chmodSync(locked, 0o000);

    try {
      assert.throws(() => entriesOf(name), /EACCES|EPERM/);
    } finally {
      chmodSync(locked, 0o600);
    }
  });

  it("fails on a directory it cannot list, for the same reason", () => {
    if (process.getuid?.() === 0) return; // root reads everything

    const name = "unreadable-dir";
    const dir = freshMind(name);
    const locked = resolve(dir, "home/private");
    mkdirSync(locked, { recursive: true });
    writeFileSync(resolve(locked, "note.md"), "# secret\n");
    chmodSync(locked, 0o000);

    try {
      assert.throws(() => entriesOf(name), /EACCES|EPERM/);
    } finally {
      chmodSync(locked, 0o700);
    }
  });
});

/** Write a minimal git index (v2) naming `paths`, bypassing git's own path checks. */
function writeIndexWithPaths(indexPath: string, blobSha: string, paths: string[]): void {
  const entries = paths.map((path) => {
    const name = Buffer.from(path);
    const head = Buffer.concat([
      Buffer.alloc(40),
      Buffer.from(blobSha, "hex"),
      Buffer.from([(name.length >> 8) & 0xff, name.length & 0xff]),
      name,
    ]);
    return Buffer.concat([head, Buffer.alloc(8 - (head.length % 8) || 8)]);
  });
  const header = Buffer.alloc(12);
  header.write("DIRC", 0, "ascii");
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(paths.length, 8);
  const body = Buffer.concat([header, ...entries]);
  writeFileSync(indexPath, Buffer.concat([body, createHash("sha1").update(body).digest()]));
}

describe("SDK runtime state travels only when asked for (#1059)", () => {
  function mindWithTranscripts(name: string): string {
    const dir = freshMind(name);
    mkdirSync(resolve(dir, "home/.claude/projects/-home"), { recursive: true });
    writeFileSync(resolve(dir, "home/.claude/projects/-home/session.jsonl"), "{}\n");
    mkdirSync(resolve(dir, "home/.claude/todos"), { recursive: true });
    writeFileSync(resolve(dir, "home/.claude/todos/t.json"), "[]\n");
    mkdirSync(resolve(dir, ".mind/sessions"), { recursive: true });
    writeFileSync(resolve(dir, ".mind/sessions/main.json"), '{"sessionId":"abc"}\n');
    return dir;
  }

  for (const includeSrc of [false, true]) {
    const shape = includeSrc ? "full" : "home-only";

    it(`a ${shape} export leaves transcripts behind by default`, () => {
      mindWithTranscripts(`transcripts-off-${shape}`);
      const entries = entriesOf(`transcripts-off-${shape}`, { includeSrc });

      assert.ok(
        !entries.some((e) => e.startsWith("mind/home/.claude/projects/")),
        "transcripts are most of the weight #1059 is about",
      );
      assert.ok(!entries.some((e) => e.startsWith("mind/home/.claude/todos/")), "SDK scratch");
    });

    it(`a ${shape} export carries them with --include-sessions`, () => {
      // The ids bundled under `sessions/` resolve to these transcripts, so an
      // export that carries the pointers and drops the transcripts hands the new
      // host a mind that cannot resume. Restic gates the same paths the same way.
      mindWithTranscripts(`transcripts-on-${shape}`);
      const entries = entriesOf(`transcripts-on-${shape}`, { includeSrc, includeSessions: true });

      assert.ok(entries.includes("sessions/main.json"), "the session pointers travel");
      assert.ok(
        entries.includes("mind/home/.claude/projects/-home/session.jsonl"),
        "and so must what they resolve to",
      );
    });
  }
});

describe("SDK runtime state a mind un-ignores (#1059)", () => {
  // The template `.gitignore` hides `home/.claude/*` from the git branch, but
  // that file is the mind's own — so the gate has to be the export's, not the
  // gitignore's, in both directions.
  function unignoredTranscripts(name: string): void {
    const dir = composedMind(name);
    appendFileSync(
      resolve(dir, ".gitignore"),
      "\n!home/.claude/projects/\n!home/.claude/projects/**\n",
    );
    execFileSync("git", ["init", "-q"], { cwd: dir });
    mkdirSync(resolve(dir, "home/.claude/projects/-home"), { recursive: true });
    writeFileSync(resolve(dir, "home/.claude/projects/-home/session.jsonl"), "{}\n");
  }

  it("are still left behind by default", () => {
    unignoredTranscripts("unignored-transcripts-off");
    assert.ok(
      !entriesOf("unignored-transcripts-off").some((e) =>
        e.startsWith("mind/home/.claude/projects/"),
      ),
      "git listed them because the mind said to; the default export still must not",
    );
  });

  it("reach a plain git-repo mind, where git never reports them at all", () => {
    // The ordinary case, and the one the gate missed: the template `.gitignore`
    // hides `home/.claude/*`, and `listHomeFiles` walked `home/` only on the
    // non-git fallback — so `--include-sessions` bundled the pointers under
    // `sessions/` with nothing they resolve to.
    const name = "git-mind-transcripts";
    const dir = composedMind(name);
    execFileSync("git", ["init", "-q"], { cwd: dir });
    mkdirSync(resolve(dir, "home/.claude/projects/-home"), { recursive: true });
    writeFileSync(resolve(dir, "home/.claude/projects/-home/session.jsonl"), "{}\n");
    mkdirSync(resolve(dir, ".mind/sessions"), { recursive: true });
    writeFileSync(resolve(dir, ".mind/sessions/main.json"), '{"sessionId":"abc"}\n');

    const entries = entriesOf(name, { includeSessions: true });

    assert.ok(entries.includes("sessions/main.json"), "the pointers travel");
    assert.ok(
      entries.includes("mind/home/.claude/projects/-home/session.jsonl"),
      "and so must the transcripts they resolve to",
    );
  });

  it("are still carried with --include-sessions", () => {
    unignoredTranscripts("unignored-transcripts-on");
    assert.ok(
      entriesOf("unignored-transcripts-on", { includeSessions: true }).includes(
        "mind/home/.claude/projects/-home/session.jsonl",
      ),
      "the flag must reach the git branch too",
    );
  });
});

describe("directories that are never a mind's work (#1059)", () => {
  it("drops a git worktree's .git pointer file, not just .git directories", () => {
    // The pages extension checks out the shared commons as a worktree at
    // `home/pages/_system/`, whose `.git` is a *file* holding a `gitdir:` path
    // into this host's extension data. Archiving it plants an absolute path
    // from the exporting host in the imported mind.
    const name = "worktree-stub";
    const dir = freshMind(name);
    mkdirSync(resolve(dir, "home/pages/_system"), { recursive: true });
    writeFileSync(resolve(dir, "home/pages/_system/.git"), `gitdir: ${dir}/../pages-repo\n`);
    writeFileSync(resolve(dir, "home/pages/_system/commons.md"), "# commons\n");

    const entries = entriesOf(name, { includeSrc: true });

    assert.ok(!entries.includes("mind/home/pages/_system/.git"), "a gitdir pointer is host state");
  });

  it("drops python and virtualenv build dirs at any depth", () => {
    const name = "py-caches";
    const dir = freshMind(name);
    mkdirSync(resolve(dir, "home/projects/tool/.venv/lib"), { recursive: true });
    writeFileSync(resolve(dir, "home/projects/tool/.venv/lib/big"), "x".repeat(1024));
    mkdirSync(resolve(dir, "home/projects/tool/__pycache__"), { recursive: true });
    writeFileSync(resolve(dir, "home/projects/tool/__pycache__/m.pyc"), "x");
    writeFileSync(resolve(dir, "home/projects/tool/main.py"), "print(1)\n");

    const entries = entriesOf(name, { includeSrc: true });

    assert.ok(entries.includes("mind/home/projects/tool/main.py"), "the mind's own code travels");
    assert.ok(!entries.some((e) => e.includes(".venv")), "a virtualenv is rebuilt, never archived");
    assert.ok(!entries.some((e) => e.includes("__pycache__")), "bytecode cache");
  });
});

describe("a mind reshaping its own directory under a running export (#1058)", () => {
  it("does not follow a symlink that replaced a committed file's directory", () => {
    // git lists the path from the index, the directory it names is now a
    // symlink, and only the containment inside the read stops it. The walk
    // branch cannot be tested this way — it refuses the symlink when it walks,
    // so the swap has to land between listing and read, which needs an
    // injection point the export does not have. The guard covers both; only
    // this half is pinned.
    const name = "swap-committed";
    const dir = composedMind(name);
    mkdirSync(resolve(dir, "home/memory"), { recursive: true });
    writeFileSync(resolve(dir, "home/memory/notes.md"), "ours\n");
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["add", "home/memory/notes.md"], { cwd: dir });

    const outside = resolve(dir, "..", `${name}-outside`);
    mkdirSync(outside, { recursive: true });
    writeFileSync(resolve(outside, "notes.md"), "host secret\n");
    rmSync(resolve(dir, "home/memory"), { recursive: true, force: true });
    symlinkSync(outside, resolve(dir, "home/memory"));

    try {
      const entries = entriesOf(name);
      const notes = entries.find((e) => e.endsWith("memory/notes.md"));
      assert.ok(
        notes === undefined,
        `git still lists the committed path; it must not be read through the symlink (got ${notes})`,
      );
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("does not hang when the mind makes its .gitignore a FIFO", () => {
    // `git ls-files --others` blocks on it forever, and this is the synchronous
    // CLI path, so the export would simply never return. The timeout turns it
    // into an ordinary git failure and the walk runs instead.
    const name = "fifo-gitignore";
    const dir = freshMind(name);
    execFileSync("git", ["init", "-q"], { cwd: dir });
    rmSync(resolve(dir, ".gitignore"), { force: true });
    execFileSync("mkfifo", [resolve(dir, ".gitignore")]);

    const entries = entriesOf(name);

    assert.ok(entries.includes("mind/home/SOUL.md"), "the fallback walk carried the mind");
    assert.ok(!entries.includes("mind/.gitignore"), "and never opened the FIFO");
  });
});
