import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseReleaseNotes } from "../src/lib/release-notes.js";

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
