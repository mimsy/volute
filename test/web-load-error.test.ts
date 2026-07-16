import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadErrorMessage } from "../packages/web/src/ui/lib/load-error.js";

describe("loadErrorMessage", () => {
  it("maps the daemon's 401 'Unauthorized' message to a login prompt", () => {
    assert.equal(
      loadErrorMessage(new Error("Unauthorized"), "fallback"),
      "Your session has expired — please log in again.",
    );
  });

  it("maps a 403 'Forbidden' message to a login prompt", () => {
    assert.equal(
      loadErrorMessage(new Error("Forbidden"), "fallback"),
      "Your session has expired — please log in again.",
    );
  });

  it("maps a bodyless 'Request failed: 401' to a login prompt", () => {
    assert.equal(
      loadErrorMessage(new Error("Request failed: 401"), "fallback"),
      "Your session has expired — please log in again.",
    );
  });

  it("surfaces the real message for non-auth failures (not the connection copy)", () => {
    assert.equal(
      loadErrorMessage(new Error("Request failed: 500"), "Failed to load providers."),
      "Request failed: 500",
    );
  });

  it("falls back when the error carries no message", () => {
    assert.equal(
      loadErrorMessage(new Error(""), "Failed to load providers."),
      "Failed to load providers.",
    );
  });

  it("handles non-Error throwables", () => {
    assert.equal(loadErrorMessage("boom", "fallback"), "boom");
  });
});
