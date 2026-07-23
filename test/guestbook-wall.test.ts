import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
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
 * tracked file outside the allowlist mentions the guestbook, in its content or
 * in its name.
 *
 * Extend ALLOWED only with a documented reason, and only for references that
 * cannot influence any score or record whether an agent read or wrote.
 */

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

const ALLOWED = new Set([
  ".claude/skills/volute-coder/SKILL.md", // the door: arrival + completion mentions
  // The conductor's door and its reviewer-role wall. References the guestbook only
  // to (a) bind the conductor to never observe/score coder entries and (b) offer the
  // conductor its own entry via its own chore PR — it never reads entries, counts
  // them, or records who wrote.
  ".claude/skills/volute-conductor/SKILL.md",
  "CLAUDE.md", // the reviewer rule: guestbook/ is not work product
  "CHANGELOG.md", // release-please writes squash titles here; feature-level only, never entries
  "test/guestbook-wall.test.ts", // this wall
  // The twin of this wall: asserts the invitation stays IN the pipeline. It reads
  // the SKILL.md invitation and PREFACE.md constant only — never entries, never a
  // count of who wrote — so it keeps salience up without any path to a score.
  "test/guestbook-invitation.test.ts",
]);

// Runs git with NUL-delimited output (-z), returning literal paths — immune to
// core.quotepath mangling of non-ASCII filenames. git grep exits 1 on zero
// matches; that's a pass, not an error.
function gitZ(args: string[]): string[] {
  try {
    return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" })
      .split("\0")
      .filter(Boolean);
  } catch (err) {
    if ((err as { status?: number }).status === 1) return [];
    throw err;
  }
}

describe("guestbook wall", () => {
  it("the guestbook exists: preface and entries directory", () => {
    assert.ok(existsSync(join(REPO_ROOT, "guestbook/PREFACE.md")), "guestbook/PREFACE.md missing");
    assert.ok(existsSync(join(REPO_ROOT, "guestbook/entries")), "guestbook/entries/ missing");
  });

  it("nothing outside the allowlist references the guestbook", () => {
    // --cached searches index blobs, not the working tree, so deleted-but-tracked
    // files can't crash the scan and unstaged edits can't dodge it.
    const byContent = gitZ(["grep", "--cached", "-i", "-l", "-z", "guestbook"]);
    const byName = gitZ(["ls-files", "-z"]).filter((file) => /guestbook/i.test(file));
    const offenders = [...new Set([...byContent, ...byName])]
      .filter((file) => !file.startsWith("guestbook/") && !ALLOWED.has(file))
      .sort();
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
