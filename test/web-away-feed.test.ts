import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dividerIndex } from "../packages/web/src/ui/lib/away-feed.js";

describe("dividerIndex", () => {
  // Newest-first timestamps
  const t = (n: number) => n * 1000;

  it("returns -1 with no prior visit", () => {
    assert.equal(dividerIndex([t(3), t(2), t(1)], null), -1);
  });

  it("returns -1 for an empty feed", () => {
    assert.equal(dividerIndex([], t(5)), -1);
  });

  it("returns -1 when nothing is new (first item at/older than last seen)", () => {
    assert.equal(dividerIndex([t(3), t(2), t(1)], t(3)), -1);
    assert.equal(dividerIndex([t(3), t(2), t(1)], t(10)), -1);
  });

  it("returns -1 when everything is new", () => {
    assert.equal(dividerIndex([t(3), t(2), t(1)], t(0)), -1);
  });

  it("returns the index of the first item at or older than last seen", () => {
    assert.equal(dividerIndex([t(5), t(4), t(3), t(2)], t(3)), 2);
    assert.equal(dividerIndex([t(5), t(4)], t(4)), 1);
  });
});
