import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatStartupFailure } from "../src/commands/up.js";

describe("formatStartupFailure", () => {
  it("reports a timeout when the daemon never exited", () => {
    assert.equal(
      formatStartupFailure(null, 30_000),
      "Daemon started but did not become healthy within 30s.",
    );
  });

  it("names the exit code when the daemon died with one", () => {
    assert.equal(
      formatStartupFailure({ code: 1, signal: null }, 30_000),
      "Daemon exited (exit code 1) before becoming healthy.",
    );
  });

  it("names the signal when the daemon was killed by one", () => {
    assert.equal(
      formatStartupFailure({ code: null, signal: "SIGKILL" }, 30_000),
      "Daemon exited (signal SIGKILL) before becoming healthy.",
    );
  });

  it("prefers the signal over the exit code when both are present", () => {
    assert.equal(
      formatStartupFailure({ code: 0, signal: "SIGTERM" }, 30_000),
      "Daemon exited (signal SIGTERM) before becoming healthy.",
    );
  });

  it("renders the timeout in seconds", () => {
    assert.equal(
      formatStartupFailure(null, 5_000),
      "Daemon started but did not become healthy within 5s.",
    );
  });
});
