import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatSender } from "../packages/cli/src/lib/format-cli.js";

describe("formatSender", () => {
  it("renders 'Display Name (@username)' when a distinct display name exists", () => {
    assert.equal(formatSender("cricket", "Cricket Song"), "Cricket Song (@cricket)");
  });

  it("returns the name unchanged when there is no display name", () => {
    assert.equal(formatSender("cricket", null), "cricket");
    assert.equal(formatSender("cricket", undefined), "cricket");
    assert.equal(formatSender("cricket"), "cricket");
  });

  it("returns the name unchanged when the display name equals the username", () => {
    assert.equal(formatSender("cricket", "cricket"), "cricket");
  });
});
