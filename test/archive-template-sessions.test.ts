import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createExportArchive, extractArchive } from "../packages/daemon/src/lib/mind/archive.js";
import { importMindFromArchive } from "../packages/daemon/src/lib/mind/lifecycle.js";
import {
  findMind,
  mindDir,
  removeMind,
  stateDir,
} from "../packages/daemon/src/lib/mind/registry.js";
import {
  prepareCodexImport,
  rewritePiSessionCwds,
  withPiSessionCwd,
} from "../packages/daemon/src/lib/template/import-utils.js";

/**
 * pi and codex minds keep their session state under `.mind/`, which every export
 * walks. Two things followed from that: a codex mind's export carried the host's
 * OpenAI OAuth refresh token off the machine (#1191), and `--include-sessions`
 * meant nothing for either template (#1084). And a pi session that does travel
 * names the exporting host's home in its header, which pi's resume filters on —
 * so an imported mind whose sessions came with it still woke up empty.
 */

const mindNames: string[] = [];
const scratch: string[] = [];

after(async () => {
  for (const name of mindNames) {
    if (await findMind(name)) await removeMind(name);
    rmSync(mindDir(name), { recursive: true, force: true });
    rmSync(stateDir(name), { recursive: true, force: true });
  }
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function freshMind(name: string): string {
  mindNames.push(name);
  const dir = mindDir(name);
  mkdirSync(resolve(dir, "home/.config"), { recursive: true });
  writeFileSync(resolve(dir, "home/SOUL.md"), "# Soul\n");
  writeFileSync(resolve(dir, "home/.config/volute.json"), "{}\n");
  return dir;
}

function put(dir: string, rel: string, content: string | Buffer): void {
  const path = resolve(dir, rel);
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

function tmp(prefix: string): string {
  const dir = mkdtempSync(resolve(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

type Opts = {
  includeSrc?: boolean;
  includeSessions?: boolean;
  includeEnv?: boolean;
  includeIdentity?: boolean;
  includeConnectors?: boolean;
};

function entriesOf(name: string, template: string, opts: Opts = {}): string[] {
  return createExportArchive({ name, template, ...opts })
    .getEntries()
    .map((e) => e.entryName);
}

const everything: Opts = {
  includeSessions: true,
  includeEnv: true,
  includeIdentity: true,
  includeConnectors: true,
};

describe("an export never carries the host's credentials (#1191)", () => {
  // One per template: the daemon writes each on every mind start.
  const hostSecrets = [
    "home/.claude/.credentials.json",
    ".mind/pi-agent/auth.json",
    ".mind/codex/auth.json",
    ".mind/codex/shell_snapshots/abc.sh",
  ];

  for (const includeSrc of [false, true]) {
    const label = includeSrc ? "a full export" : "a home-only export";

    for (const template of ["claude", "pi", "codex"]) {
      it(`${label} of a ${template} mind leaves them out, even asked for everything`, () => {
        const name = `secrets-${template}-${includeSrc ? "full" : "home"}`;
        const dir = freshMind(name);
        for (const rel of hostSecrets) put(dir, rel, "host-secret\n");
        put(dir, "home/.zshenv", "export VOLUTE_MIND_TOKEN=live-token\n");
        put(dir, ".mind/codex/config.toml", 'cli_auth_credentials_store = "file"\n');
        put(dir, ".mind/pi-agent/settings.json", "{}\n");

        for (const opts of [{}, everything]) {
          const entries = entriesOf(name, template, { includeSrc, ...opts });
          for (const keep of [".mind/codex/config.toml", ".mind/pi-agent/settings.json"]) {
            assert.ok(entries.includes(`mind/${keep}`), `the rest still travels: ${keep}`);
          }
          for (const rel of hostSecrets) assert.ok(!entries.includes(`mind/${rel}`), rel);
          // A codex mind's `.zshenv` is the daemon's, carrying the mind's live
          // token; any other mind's is its own.
          assert.equal(entries.includes("mind/home/.zshenv"), template !== "codex", ".zshenv");
        }
      });
    }
  }
});

describe("--include-sessions gates pi and codex sessions too (#1084)", () => {
  const sessionFiles = [
    "mind/.mind/pi-sessions/main/2026-09-01_abc.jsonl",
    "mind/.mind/pi-sessions/archive/main-2026-08-01T00-00/old.jsonl",
    "mind/.mind/codex-sessions/main.json",
    "mind/.mind/codex/sessions/2026/09/01/rollout-x-abc.jsonl",
  ];

  for (const includeSrc of [false, true]) {
    const label = includeSrc ? "a full export" : "a home-only export";

    it(`${label} carries them only when asked, and each once`, () => {
      const name = `tpl-sessions-${includeSrc ? "full" : "home"}`;
      const dir = freshMind(name);
      for (const file of sessionFiles) put(dir, file.slice("mind/".length), "{}\n");
      put(dir, ".mind/keep.json", "{}\n");

      const without = entriesOf(name, "pi", { includeSrc });
      assert.ok(without.includes("mind/.mind/keep.json"), "the rest of .mind/ still travels");
      for (const file of sessionFiles) assert.ok(!without.includes(file), `${file} without flag`);

      const withSessions = entriesOf(name, "pi", { includeSrc, includeSessions: true });
      for (const file of sessionFiles) assert.ok(withSessions.includes(file), `${file} with flag`);
      assert.equal(new Set(withSessions).size, withSessions.length, "no entry is added twice");
    });
  }
});

describe("pi session headers follow the mind to its new home", () => {
  const header = { type: "session", version: 3, id: "abc", cwd: "/old/host/minds/pip/home" };
  // Not valid UTF-8 past the header: decoding and re-encoding would corrupt it.
  const body = Buffer.concat([
    Buffer.from('{"type":"message","id":"m1","text":"cwd: /old/host '),
    Buffer.from([0xff, 0xfe]),
    Buffer.from('"}\n{"type":"x"}\n'),
  ]);
  const session = Buffer.concat([Buffer.from(`${JSON.stringify(header)}\n`), body]);

  function headerOf(data: Buffer): Record<string, unknown> {
    return JSON.parse(data.subarray(0, data.indexOf(0x0a)).toString("utf-8"));
  }

  it("rewrites only the header line", () => {
    const out = withPiSessionCwd(session, "/new/home");
    assert.ok(out);
    assert.deepEqual(headerOf(out), { ...header, cwd: "/new/home" });
    assert.ok(out.subarray(out.indexOf(0x0a) + 1).equals(body), "every other byte is untouched");
  });

  it("leaves a file without a session header alone", () => {
    assert.equal(withPiSessionCwd(Buffer.from('{"type":"message"}\n'), "/new/home"), null);
    assert.equal(withPiSessionCwd(Buffer.from("not json\n"), "/new/home"), null);
  });

  it("rewrites live and archived sessions, and follows no link", () => {
    const root = tmp("pi-cwd-");
    const outside = tmp("pi-cwd-outside-");
    put(root, ".mind/pi-sessions/main/a.jsonl", session);
    put(root, ".mind/pi-sessions/archive/main-2026-08-01T00-00/b.jsonl", session);
    put(outside, "c.jsonl", session);
    symlinkSync(outside, resolve(root, ".mind/pi-sessions/linked"));
    symlinkSync(resolve(outside, "c.jsonl"), resolve(root, ".mind/pi-sessions/main/c.jsonl"));

    rewritePiSessionCwds(root, "/new/home");

    for (const rel of ["main/a.jsonl", "archive/main-2026-08-01T00-00/b.jsonl"]) {
      assert.equal(
        headerOf(readFileSync(resolve(root, ".mind/pi-sessions", rel))).cwd,
        "/new/home",
      );
    }
    assert.ok(readFileSync(resolve(outside, "c.jsonl")).equals(session), "links not followed");
  });

  it("a full-archive import under a new name resumes the session pi was on", async () => {
    const from = "pi-export-src";
    const to = "pi-import-dest";
    const dir = freshMind(from);
    mindNames.push(to);
    put(dir, "package.json", '{"name":"pi-import-dest","private":true}\n');
    // Two sessions in one dir.
    const older = "2026-09-01T10-00-00-000Z_old.jsonl";
    const newer = "2026-09-02T10-00-00-000Z_abc.jsonl";
    put(dir, `.mind/pi-sessions/main/${newer}`, session);
    put(dir, `.mind/pi-sessions/main/${older}`, session);

    const archivePath = resolve(tmp("pi-archive-"), "pip.volute");
    createExportArchive({
      name: from,
      template: "pi",
      includeSrc: true,
      includeSessions: true,
    }).writeZip(archivePath);
    const tempDir = tmp("pi-extract-");
    const { manifest } = extractArchive(archivePath, tempDir);
    // Every step of the round trip leaves mtimes in whatever order it happened
    // to go; make that order the wrong one.
    const late = new Date(Date.now() + 60_000);
    utimesSync(resolve(tempDir, "mind/.mind/pi-sessions/main", older), late, late);

    const result = await importMindFromArchive(tempDir, to, manifest);
    assert.ok(result.ok, JSON.stringify(result));

    // Canonical, as the mind's own `process.cwd()` reports it — the tmpdir the
    // test home lives in is itself behind a link on macOS.
    const home = resolve(realpathSync(mindDir(to)), "home");
    const sessionDir = resolve(mindDir(to), ".mind/pi-sessions/main");
    const text = readFileSync(resolve(sessionDir, newer));
    assert.equal(headerOf(text).cwd, home);
    assert.ok(text.subarray(text.indexOf(0x0a) + 1).equals(body));

    // What the template itself calls on start.
    const resumed = SessionManager.continueRecent(home, sessionDir).getSessionFile();
    assert.equal(resumed && basename(resumed), newer, "pi resumes the newest session");
    // Deterministically, not by the luck of which file was written last: each
    // carries the time its name gives.
    assert.equal(
      statSync(resolve(sessionDir, older)).mtime.toISOString(),
      "2026-09-01T10:00:00.000Z",
    );
    assert.equal(
      statSync(resolve(sessionDir, newer)).mtime.toISOString(),
      "2026-09-02T10:00:00.000Z",
    );
  });
});

describe("pi session headers follow a home-only import too", () => {
  const header = { type: "session", version: 3, id: "abc", cwd: "/old/host/minds/pip/home" };
  const session = `${JSON.stringify(header)}\n{"type":"x"}\n`;

  it("points the sessions at the new home", async () => {
    const from = "pi-home-src";
    const to = "pi-home-dest";
    const dir = freshMind(from);
    mindNames.push(to);
    put(dir, ".mind/pi-sessions/main/2026-09-01T10-00-00-000Z_abc.jsonl", session);

    const archivePath = resolve(tmp("pi-archive-"), "pip.volute");
    createExportArchive({ name: from, template: "pi", includeSessions: true }).writeZip(
      archivePath,
    );
    const tempDir = tmp("pi-extract-");
    const { manifest } = extractArchive(archivePath, tempDir);

    const result = await importMindFromArchive(tempDir, to, manifest);
    assert.ok(result.ok, JSON.stringify(result));

    const dest = mindDir(to);
    const text = readFileSync(
      resolve(dest, ".mind/pi-sessions/main/2026-09-01T10-00-00-000Z_abc.jsonl"),
      "utf-8",
    );
    assert.equal(
      JSON.parse(text.slice(0, text.indexOf("\n"))).cwd,
      resolve(realpathSync(dest), "home"),
    );
    assert.equal(
      statSync(
        resolve(dest, ".mind/pi-sessions/main/2026-09-01T10-00-00-000Z_abc.jsonl"),
      ).mtime.toISOString(),
      "2026-09-01T10:00:00.000Z",
      "the mtime pi resumes by survives the copy into the mind dir",
    );
  });
});

describe("both codex homes are judged the same way (#1229)", () => {
  // `.mind/codex` is CODEX_HOME under an OAuth provider; `home/.codex` is where codex
  // keeps everything with an API key under `isolation: user`.
  const homes = [".mind/codex", "home/.codex"];
  const never = [
    "auth.json",
    "shell_snapshots/019a.sh",
    "state_5.sqlite",
    "state_5.sqlite-wal",
    "state_5.sqlite-shm",
    "logs_2.sqlite",
    "logs_2.sqlite-wal",
    ".tmp/plugins/some-plugin/README.md",
    "tmp/x",
    "cache/x",
    "log/codex-tui.log",
    "models_cache.json",
  ];
  const sessions = [
    "sessions/2026/09/01/rollout-2026-09-01T10-00-00-abc.jsonl",
    "archived_sessions/rollout-2026-08-01T10-00-00-old.jsonl",
    "history.jsonl",
    "thread_history_1.sqlite",
  ];
  const kept = ["config.toml", "memories_1.sqlite", "skills/x/SKILL.md"];

  for (const includeSrc of [false, true]) {
    const label = includeSrc ? "a full export" : "a home-only export";

    for (const template of ["codex", "claude"]) {
      it(`${label} of a ${template} mind drops secrets, index and caches, and gates sessions`, () => {
        const name = `codex-homes-${template}-${includeSrc ? "full" : "home"}`;
        const dir = freshMind(name);
        for (const home of homes) {
          for (const rel of [...never, ...sessions, ...kept]) {
            put(dir, `${home}/${rel}`, "x\n");
          }
        }
        // Every real mind is a repo whose `.gitignore` hides `home/*` from the listing.
        put(dir, ".gitignore", "home/*\n!home/SOUL.md\n");
        put(dir, "home/ignored.txt", "x\n");
        execFileSync("git", ["init", "-q"], { cwd: dir });

        for (const opts of [{}, everything]) {
          const entries = entriesOf(name, template, { includeSrc, ...opts });
          assert.equal(entries.includes("mind/home/ignored.txt"), includeSrc, "git was asked");
          for (const home of homes) {
            for (const rel of never) {
              assert.ok(!entries.includes(`mind/${home}/${rel}`), `${home}/${rel}`);
            }
            for (const rel of sessions) {
              assert.equal(
                entries.includes(`mind/${home}/${rel}`),
                opts === everything,
                `${home}/${rel} ${opts === everything ? "with" : "without"} sessions`,
              );
            }
            for (const rel of kept) {
              assert.ok(entries.includes(`mind/${home}/${rel}`), `kept: ${home}/${rel}`);
            }
          }
        }
      });
    }
  }

  it("a home-only export walks in home/.codex's rollouts, which git never reports", () => {
    const name = "codex-homes-git";
    const dir = freshMind(name);
    put(dir, ".gitignore", "home/*\n!home/SOUL.md\n");
    put(dir, "home/ignored.txt", "x\n");
    put(dir, "home/.codex/sessions/2026/09/01/rollout-2026-09-01T10-00-00-abc.jsonl", "x\n");
    put(dir, "home/.codex/auth.json", "x\n");
    put(dir, ".mind/codex-sessions/main.json", '{"threadId":"abc"}');
    execFileSync("git", ["init", "-q"], { cwd: dir });

    const rollout = "mind/home/.codex/sessions/2026/09/01/rollout-2026-09-01T10-00-00-abc.jsonl";
    const withSessions = entriesOf(name, "codex", { includeSessions: true });
    assert.ok(!withSessions.includes("mind/home/ignored.txt"), "git listing was used");
    assert.ok(withSessions.includes(rollout), "the rollout travels with its pointer");
    assert.ok(withSessions.includes("mind/.mind/codex-sessions/main.json"));
    assert.ok(!withSessions.includes("mind/home/.codex/auth.json"));
    assert.ok(!entriesOf(name, "codex").includes(rollout), "and not without the flag");
  });
});

describe("an imported codex mind resumes its own threads (#1194)", () => {
  const rolloutRel = "sessions/2026/09/01/rollout-2026-09-01T10-00-00-t-carried.jsonl";
  const now = new Date("2026-09-28T13:22:45.123Z");

  it("drops codex's thread index from both homes, whatever the archive carried", () => {
    const root = tmp("codex-prep-");
    for (const home of [".mind/codex", "home/.codex"]) {
      for (const f of ["state_5.sqlite", "state_5.sqlite-wal", "state_5.sqlite-shm"]) {
        put(root, `${home}/${f}`, "x");
      }
      put(root, `${home}/config.toml`, "x");
    }
    prepareCodexImport(root, now);
    for (const home of [".mind/codex", "home/.codex"]) {
      assert.deepEqual(readdirSync(resolve(root, home)), ["config.toml"], home);
    }
  });

  it("keeps a pointer whose rollout came along and archives one whose did not", () => {
    const root = tmp("codex-prep-");
    put(root, `home/.codex/${rolloutRel}`, "{}\n");
    put(root, ".mind/codex-sessions/main.json", '{"threadId":"t-carried","committed":true}');
    put(root, ".mind/codex-sessions/other.json", '{"threadId":"t-elsewhere","committed":true}');
    put(root, ".mind/codex-sessions/idle.json", '{"threadId":"t-idle","committed":false}');
    put(root, ".mind/codex-sessions/archive/main-2026-08-01T00-00.json", '{"threadId":"t-old"}');

    prepareCodexImport(root, now);

    const sessionsDir = resolve(root, ".mind/codex-sessions");
    assert.deepEqual(readdirSync(sessionsDir).sort(), ["archive", "main.json"]);
    assert.deepEqual(readdirSync(resolve(sessionsDir, "archive")).sort(), [
      "idle-2026-09-28T13-22.json",
      "main-2026-08-01T00-00.json",
      "other-2026-09-28T13-22.json",
    ]);
    const archived = (f: string) =>
      JSON.parse(readFileSync(resolve(sessionsDir, "archive", f), "utf-8"));
    // Marked, so the mind is told what it lost — but only for a thread that held a turn.
    assert.deepEqual(archived("other-2026-09-28T13-22.json"), {
      threadId: "t-elsewhere",
      committed: true,
      rolloutLeftBehind: true,
    });
    assert.deepEqual(archived("idle-2026-09-28T13-22.json"), {
      threadId: "t-idle",
      committed: false,
    });
  });

  it("never archives through a link", () => {
    const root = tmp("codex-prep-");
    const outside = tmp("codex-prep-outside-");
    put(root, ".mind/codex-sessions/main.json", '{"threadId":"t-elsewhere"}');
    symlinkSync(outside, resolve(root, ".mind/codex-sessions/archive"));

    prepareCodexImport(root, now);

    assert.deepEqual(readdirSync(outside), [], "nothing was written through the link");
    assert.ok(!existsSync(resolve(root, ".mind/codex-sessions/main.json")), "pointer dropped");

    // A dangling link, too, is refused rather than failing the import.
    const dangling = tmp("codex-prep-");
    put(dangling, ".mind/codex-sessions/main.json", '{"threadId":"t-elsewhere"}');
    symlinkSync(resolve(outside, "gone"), resolve(dangling, ".mind/codex-sessions/archive"));
    prepareCodexImport(dangling, now);
    assert.ok(!existsSync(resolve(dangling, ".mind/codex-sessions/main.json")), "pointer dropped");
    assert.deepEqual(readdirSync(outside), []);
  });

  for (const includeSrc of [true, false]) {
    const label = includeSrc ? "a full-archive" : "a home-only";

    it(`${label} import under a new name keeps the thread and none of the old host's index`, async () => {
      const from = `codex-src-${includeSrc ? "full" : "home"}`;
      const to = `codex-dest-${includeSrc ? "full" : "home"}`;
      const dir = freshMind(from);
      mindNames.push(to);
      put(dir, "package.json", `{"name":"${to}","private":true}\n`);
      put(dir, `home/.codex/${rolloutRel}`, '{"type":"session_meta"}\n');
      put(dir, "home/.codex/state_5.sqlite", "index naming the old home");
      put(dir, ".mind/codex/state_5.sqlite", "index naming the old home");
      put(dir, ".mind/codex-sessions/main.json", '{"threadId":"t-carried","committed":true}');

      const archivePath = resolve(tmp("codex-archive-"), "cx.volute");
      createExportArchive({
        name: from,
        template: "codex",
        includeSrc,
        includeSessions: true,
      }).writeZip(archivePath);
      const tempDir = tmp("codex-extract-");
      const { manifest } = extractArchive(archivePath, tempDir);
      // An archive written before #1229 carries the index; the import must not trust it.
      put(tempDir, "mind/home/.codex/state_5.sqlite", "index naming the old home");
      put(tempDir, "mind/.mind/codex/state_5.sqlite", "index naming the old home");

      const result = await importMindFromArchive(tempDir, to, manifest);
      assert.ok(result.ok, JSON.stringify(result));

      const dest = mindDir(to);
      assert.ok(existsSync(resolve(dest, `home/.codex/${rolloutRel}`)), "the rollout came along");
      assert.deepEqual(
        JSON.parse(readFileSync(resolve(dest, ".mind/codex-sessions/main.json"), "utf-8")),
        { threadId: "t-carried", committed: true },
      );
      for (const home of ["home/.codex", ".mind/codex"]) {
        assert.ok(!existsSync(resolve(dest, home, "state_5.sqlite")), `${home} index dropped`);
      }
    });
  }
});
