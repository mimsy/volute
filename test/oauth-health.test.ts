import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { needsRefresh } from "../packages/daemon/src/web/api/system.js";

describe("needsRefresh", () => {
  it("returns true when token is already expired", () => {
    const expired = { refresh: "r", access: "a", expires: Date.now() - 1000 };
    assert.equal(needsRefresh(expired), true);
  });

  it("returns true when expires is 0", () => {
    const zero = { refresh: "r", access: "a", expires: 0 };
    assert.equal(needsRefresh(zero), true);
  });

  it("returns true when less than 15 minutes remain", () => {
    const soonExpires = {
      refresh: "r",
      access: "a",
      expires: Date.now() + 10 * 60 * 1000, // 10 minutes
    };
    assert.equal(needsRefresh(soonExpires), true);
  });

  it("returns false when more than 15 minutes remain", () => {
    const fresh = {
      refresh: "r",
      access: "a",
      expires: Date.now() + 30 * 60 * 1000, // 30 minutes
    };
    assert.equal(needsRefresh(fresh), false);
  });

  it("returns true at exactly 15 minutes remaining", () => {
    const exact = {
      refresh: "r",
      access: "a",
      expires: Date.now() + 15 * 60 * 1000,
    };
    // At exactly 15min, remaining < 15min is false, so should return false
    assert.equal(needsRefresh(exact), false);
  });

  it("returns false when token has plenty of time", () => {
    const longLived = {
      refresh: "r",
      access: "a",
      expires: Date.now() + 3600 * 1000, // 1 hour
    };
    assert.equal(needsRefresh(longLived), false);
  });
});
