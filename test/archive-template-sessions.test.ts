import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
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
