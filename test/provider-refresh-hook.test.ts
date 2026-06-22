import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  fireProviderRefreshHook,
  setProviderRefreshHook,
} from "../packages/daemon/src/lib/ai-service.js";

describe("provider refresh hook", () => {
  afterEach(() => setProviderRefreshHook(undefined));

  it("fires the registered hook with the provider id", () => {
    const calls: string[] = [];
    setProviderRefreshHook((p) => calls.push(p));
    fireProviderRefreshHook("anthropic");
    assert.deepEqual(calls, ["anthropic"]);
  });

  it("is a no-op when no hook is registered", () => {
    setProviderRefreshHook(undefined);
    assert.doesNotThrow(() => fireProviderRefreshHook("anthropic"));
  });

  it("swallows errors thrown by the hook", () => {
    setProviderRefreshHook(() => {
      throw new Error("boom");
    });
    assert.doesNotThrow(() => fireProviderRefreshHook("anthropic"));
  });
});
