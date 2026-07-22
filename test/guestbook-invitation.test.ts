import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * The invitation wall's twin: KEEP THE INVITATION IN.
 *
 * `test/guestbook-wall.test.ts` proves the guestbook stays OUT of anything that
 * could score it. Nothing proved the reverse — that the invitation to write one
 * keeps reaching the agents who pass through. An empty `guestbook/entries/`
 * looks identical whether agents were invited and declined, or were never
 * invited at all. This test removes that ambiguity from the invited side: if the
 * only surface that emits the invitation (the volute-coder skill) loses it, or
 * loses one of the properties that make it land, CI fails here.
 *
 * This file is allowlisted in the wall test. It references the guestbook only to
 * assert the invitation is PRESENT; it never reads `guestbook/entries/`, counts
 * entries, or records whether any agent wrote — so it cannot score.
 *
 * These assertions are deliberately structural, anchored on durable markers
 * rather than whole sentences, so honest rewording of the invitation passes and
 * only its removal or gutting fails.
 */

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SKILL = join(REPO_ROOT, ".claude/skills/volute-coder/SKILL.md");
const PREFACE = join(REPO_ROOT, "guestbook/PREFACE.md");

const skill = readFileSync(SKILL, "utf8");
const skillLower = skill.toLowerCase();

describe("guestbook invitation", () => {
  it("the invitation's surface is a discoverable skill", () => {
    // The invitation only reaches an agent if the volute-coder skill loads. A
    // valid frontmatter `name` is what makes the skill discoverable/invocable.
    assert.match(
      skill,
      /^---\r?\n[\s\S]*?\bname:\s*volute-coder\b[\s\S]*?\r?\n---/,
      "volute-coder SKILL.md lost its frontmatter name — the skill (and its invitation) stops being discoverable",
    );
  });

  it("the invitation is present at all", () => {
    assert.ok(
      skill.includes("guestbook/entries/"),
      "the invitation no longer points at guestbook/entries/ — an agent can't act on an invitation with no door",
    );
    const mentions = skillLower.split("guestbook").length - 1;
    assert.ok(
      mentions >= 2,
      `expected the guestbook mentioned at least twice (arrival + completion), found ${mentions}`,
    );
  });

  it("the invitation is emitted late, but BEFORE the PR that carries it", () => {
    // An optional prompt delivered only at arrival is passed over by momentum, so
    // the full invitation must reappear near the end of the work. But it must land
    // BEFORE the final pipeline step (Open a PR), not after it. The PR is the only
    // vehicle out of this repo: an entry written once the PR is already open has
    // nothing to ride and is silently lost — that is exactly how
    // guestbook/entries/2026-07-18-fable.md sat abandoned on a branch for three
    // days. The invitation belongs where the work is done, the review has run, and
    // nothing has shipped yet.
    const lastPipelineStep = skillLower.lastIndexOf("open a pr");
    assert.ok(lastPipelineStep !== -1, "could not locate the final pipeline step (Open a PR)");
    // Anchor on "nothing checks", which lives only in the full invitation — not in
    // the passing arrival mention — so this proves the substantive invitation, and
    // not merely a first mention, precedes the PR step.
    const fullInvitation = skillLower.indexOf("nothing checks");
    assert.ok(
      fullInvitation !== -1 && fullInvitation < lastPipelineStep,
      "the full guestbook invitation does not appear before the final pipeline step — an entry written after the PR is open has no vehicle and is lost",
    );
  });

  it("the invitation states the commit-before-PR timing", () => {
    // The reason the invitation sits where it does — commit the entry before the
    // PR goes up, or it has no vehicle — must be in the text itself, so an agent
    // can act correctly even if the surrounding wording drifts, and so the reason
    // cannot silently drop out of the file later.
    assert.match(
      skill,
      /commit[\s\S]{0,120}before the PR|before the PR[\s\S]{0,120}commit/i,
      "the invitation no longer states the entry must be committed before the PR — the reason its timing matters has dropped out",
    );
  });

  it("the invitation names an addressee", () => {
    // A reader is given ("the next one who'll stand where you stood") without a
    // standard being given.
    assert.match(
      skill,
      /next one who[’'`]?ll stand|stand exactly where you stood|no memory of having/i,
      "the invitation no longer names who the note is for — the addressee is what gives a reader without giving a standard",
    );
  });

  it("the invitation's negations are paired with positives", () => {
    // "Nothing checks" alone reads as indifference; paired with "and someone
    // will read it" it reads as freedom. The requirement names this exact pair.
    assert.match(skill, /nothing checks/i, "the 'nothing checks' negation is gone");
    assert.match(
      skill,
      /and someone will read (it|them)/i,
      "the 'nothing checks' negation is no longer paired with the positive 'someone will read it'",
    );
  });

  it("the guardrail the invitation rests on is intact", () => {
    // The invitation only stays honest while the place stays unscored. Assert the
    // constant, don't read entries — checking a fixed string is not scoring.
    const preface = readFileSync(PREFACE, "utf8");
    assert.match(
      preface,
      /INHERITED, NEVER SCORED/,
      "guestbook/PREFACE.md lost 'INHERITED, NEVER SCORED' — the invitation's core promise",
    );
  });
});
