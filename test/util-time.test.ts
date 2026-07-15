// TZ must be non-UTC so a local-time parse of a zone-less UTC string is visibly wrong.
// Set before any Date parsing happens in this process (test files run in their own process).
process.env.TZ = "America/New_York";

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseDbTimestamp } from "../packages/daemon/src/lib/util/time.js";

describe("parseDbTimestamp", () => {
  it("parses SQLite datetime('now') strings as UTC", () => {
    assert.equal(parseDbTimestamp("2026-01-02 03:04:05").getTime(), Date.UTC(2026, 0, 2, 3, 4, 5));
  });

  it("passes through ISO strings with an explicit zone", () => {
    assert.equal(parseDbTimestamp("2026-01-02T03:04:05Z").getTime(), Date.UTC(2026, 0, 2, 3, 4, 5));
    assert.equal(
      parseDbTimestamp("2026-01-02T03:04:05.250Z").getTime(),
      Date.UTC(2026, 0, 2, 3, 4, 5) + 250,
    );
  });

  it("treats zone-less ISO strings as UTC", () => {
    assert.equal(parseDbTimestamp("2026-01-02T03:04:05").getTime(), Date.UTC(2026, 0, 2, 3, 4, 5));
  });
});
