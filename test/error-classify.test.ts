import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classify } from "../packages/daemon/src/lib/daemon/error-classify.js";

describe("error classify", () => {
  it("classifies 401 / authentication errors as auth_error", () => {
    const cases = [
      "API Error: 401 {...authentication_error...}",
      "Invalid authentication credentials",
      "invalid x-api-key",
      "403 permission_error",
    ];
    for (const c of cases) {
      assert.equal(classify(c).reason, "auth_error", c);
      assert.match(classify(c).detail, /credential/i);
    }
  });

  it("classifies missing / invalid API key errors as actionable auth_error", () => {
    const cases = [
      "Invalid API key",
      "missing API key",
      "no API key provided",
      "x-api-key header is required",
      "Could not resolve authentication method",
      "Please run /login",
    ];
    for (const c of cases) {
      assert.equal(classify(c).reason, "auth_error", c);
      // Actionable: points the host at setting a key / reconnecting the provider.
      assert.match(classify(c).detail, /volute env set|provider/i, c);
    }
  });

  it("classifies rate limit and overload errors", () => {
    assert.equal(classify("429 Too Many Requests").reason, "rate_limit");
    assert.equal(classify("rate limit exceeded").reason, "rate_limit");
    assert.equal(classify("529 overloaded_error").reason, "overloaded");
  });

  it("classifies network errors", () => {
    assert.equal(classify("fetch failed: ECONNRESET").reason, "network");
    assert.equal(classify("connect ETIMEDOUT").reason, "network");
    assert.equal(classify("socket hang up").reason, "network");
  });

  it("falls back to unknown and includes the raw text", () => {
    const c = classify("something totally unexpected blew up");
    assert.equal(c.reason, "unknown");
    assert.match(c.detail, /something totally unexpected blew up/);
  });

  it("does not throw on empty input", () => {
    assert.equal(classify("").reason, "unknown");
  });
});
