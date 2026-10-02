import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  formatReleaseNotes,
  parseReleaseNotes,
  parseReleaseNotesSince,
} from "../packages/daemon/src/lib/release-notes.js";

describe("parseReleaseNotes", () => {
  it("parses an existing version from CHANGELOG.md", () => {
    const notes = parseReleaseNotes("0.20.0");
    assert.ok(notes !== null, "should find release notes for 0.20.0");
    assert.ok(notes.includes("Features"), "should include Features section");
  });

  it("handles v prefix", () => {
    const notes = parseReleaseNotes("v0.20.0");
    assert.ok(notes !== null, "should handle v prefix");
  });

  it("returns null for non-existent version", () => {
    const notes = parseReleaseNotes("99.99.99");
    assert.equal(notes, null);
  });

  it("strips GitHub links from output", () => {
    const notes = parseReleaseNotes("0.20.0");
    assert.ok(notes !== null);
    // Should not contain PR links like ([#123](url))
    assert.ok(!notes.match(/\(\[#\d+\]\(/), "should not contain PR links");
    // Should not contain commit links like ([abc123](url))
    assert.ok(!notes.match(/\(\[[a-f0-9]+\]\(/), "should not contain commit links");
  });

  it("includes section headings", () => {
    const notes = parseReleaseNotes("0.20.0");
    assert.ok(notes !== null);
    assert.ok(notes.includes("### Features"));
    assert.ok(notes.includes("### Bug Fixes"));
  });
});

function changelog(versions: string[], body = (v: string) => `* fix in ${v}`): string {
  const sections = versions.map(
    (v) =>
      `## [${v}](https://github.com/mimsy/volute/compare/a...b) (2026-10-02)\n\n\n### Bug Fixes\n\n${body(v)} ([#1](https://x)) ([abc123](https://x))\n`,
  );
  return `# Changelog\n\n${sections.join("\n")}`;
}

describe("parseReleaseNotesSince", () => {
  const log = changelog(["0.66.10", "0.66.9", "0.66.8", "0.66.7", "0.66.6", "0.66.5"]);

  it("returns every section after from, through to, newest first", () => {
    const sections = parseReleaseNotesSince("0.66.6", "0.66.9", log);
    assert.deepEqual(
      sections.map((s) => s.version),
      ["0.66.9", "0.66.8", "0.66.7"],
    );
    assert.equal(sections[0].notes, "### Bug Fixes\n\n* fix in 0.66.9");
  });

  it("orders by version, not by file position", () => {
    const shuffled = changelog(["0.66.7", "0.66.9", "0.66.8"]);
    assert.deepEqual(
      parseReleaseNotesSince("v0.66.6", "v0.66.9", shuffled).map((s) => s.version),
      ["0.66.9", "0.66.8", "0.66.7"],
    );
  });

  it("is just the current section for a single-step upgrade", () => {
    const sections = parseReleaseNotesSince("0.66.8", "0.66.9", log);
    assert.deepEqual(sections, [{ version: "0.66.9", notes: parseReleaseNotes("0.66.9", log) }]);
  });

  it("falls back to the current section when a version can't be parsed", () => {
    for (const [from, to] of [
      ["garbage", "0.66.9"],
      ["", "0.66.9"],
      ["0.66.10", "0.66.9"],
    ]) {
      assert.deepEqual(
        parseReleaseNotesSince(from, to, log).map((s) => s.version),
        ["0.66.9"],
        `${from} → ${to}`,
      );
    }
  });

  it("is empty without a changelog", () => {
    assert.deepEqual(parseReleaseNotesSince("0.66.6", "0.66.9", null), []);
  });
});

describe("formatReleaseNotes", () => {
  it("leaves a single section exactly as it was", () => {
    assert.equal(formatReleaseNotes([{ version: "0.66.9", notes: "* a" }], "0.66.8"), "* a");
    assert.equal(formatReleaseNotes([], "0.66.8"), null);
  });

  it("heads each of several sections with its version", () => {
    const text = formatReleaseNotes(
      [
        { version: "0.66.9", notes: "* nine" },
        { version: "0.66.8", notes: "* eight" },
      ],
      "0.66.7",
    );
    assert.equal(text, "## v0.66.9\n\n* nine\n\n## v0.66.8\n\n* eight");
  });

  it("caps at five sections and names what it left out", () => {
    const versions = Array.from({ length: 8 }, (_, i) => `0.66.${10 - i}`);
    const sections = parseReleaseNotesSince("0.66.2", "0.66.10", changelog(versions));
    assert.equal(sections.length, 8);
    const text = formatReleaseNotes(sections, "0.66.2")!;
    assert.equal((text.match(/^## v/gm) ?? []).length, 5);
    assert.ok(text.includes("## v0.66.6") && !text.includes("## v0.66.5"));
    assert.ok(
      text.endsWith(
        "…and 3 earlier releases since v0.66.2; see CHANGELOG.md in the Volute install",
      ),
    );
  });

  it("caps at about 6000 characters, always keeping the newest whole", () => {
    const big = (v: string) => `* ${v} ${"x".repeat(2500)}`;
    const sections = parseReleaseNotesSince(
      "0.66.5",
      "0.66.9",
      changelog(["0.66.9", "0.66.8", "0.66.7", "0.66.6"], big),
    );
    const text = formatReleaseNotes(sections, "0.66.5")!;
    assert.equal((text.match(/^## v/gm) ?? []).length, 2);
    assert.ok(text.length < 6200);
    assert.ok(
      text.endsWith(
        "…and 2 earlier releases since v0.66.5; see CHANGELOG.md in the Volute install",
      ),
    );

    const huge = [
      { version: "0.66.9", notes: "y".repeat(9000) },
      { version: "0.66.8", notes: "z" },
    ];
    const one = formatReleaseNotes(huge, "0.66.7")!;
    assert.ok(one.includes("y".repeat(9000)));
    assert.ok(
      one.endsWith("…and 1 earlier release since v0.66.7; see CHANGELOG.md in the Volute install"),
    );
  });
});
