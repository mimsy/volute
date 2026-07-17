import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * The guestbook wall: INHERITED, NEVER SCORED (#747, #748).
 *
 * guestbook/ entries are written by ephemeral coding agents and must never feed
 * anything that grades them. Any automation that can see the guestbook can
 * score it — a CI check, review tooling, a dashboard, a completion report — so
 * the wall is enforced as construction, not policy: this test fails if any
 * tracked file outside the allowlist mentions the guestbook at all.
 *
 * Extend ALLOWED only with a documented reason, and only for references that
 * cannot influence any score or record whether an agent read or wrote.
 */

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

const ALLOWED = new Set([
  ".claude/skills/volute-coder/SKILL.md", // the door: arrival + departure mentions
  "CLAUDE.md", // the reviewer rule: guestbook/ is not work product
  "test/guestbook-wall.test.ts", // this wall
]);

describe("guestbook wall", () => {
  it("the guestbook exists: preface and entries directory", () => {
    assert.ok(existsSync(join(REPO_ROOT, "guestbook/PREFACE.md")), "guestbook/PREFACE.md missing");
    assert.ok(existsSync(join(REPO_ROOT, "guestbook/entries")), "guestbook/entries/ missing");
  });

  it("nothing outside the allowlist references the guestbook", () => {
    const tracked = execFileSync("git", ["ls-files"], { cwd: REPO_ROOT, encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
    const offenders = tracked.filter((file) => {
      if (file.startsWith("guestbook/") || ALLOWED.has(file)) return false;
      return /guestbook/i.test(readFileSync(join(REPO_ROOT, file), "utf8"));
    });
    assert.deepEqual(
      offenders,
      [],
      "These tracked files reference the guestbook but are not allowlisted:\n  " +
        `${offenders.join("\n  ")}\n` +
        "The guestbook is INHERITED, NEVER SCORED: no automation, check, or report may " +
        "reference it. If this reference truly cannot influence any score or record " +
        "participation, add it to ALLOWED with a documented reason.",
    );
  });
});
