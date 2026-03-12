import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Hono } from "hono";
import { createExtension } from "../packages/extensions/sdk/src/index.js";

describe("createExtension", () => {
  it("should return the manifest when valid", () => {
    const manifest = createExtension({
      id: "test",
      name: "Test",
      version: "1.0.0",
      routes: () => new Hono(),
    });
    assert.equal(manifest.id, "test");
  });

  it("should throw when id is missing", () => {
    assert.throws(
      () =>
        createExtension({
          id: "",
          name: "X",
          version: "1",
          routes: () => new Hono(),
        }),
      /requires an id/,
    );
  });

  it("should throw when routes is not a function", () => {
    assert.throws(
      () =>
        createExtension({
          id: "x",
          name: "X",
          version: "1",
          routes: "bad" as any,
        }),
      /requires a routes function/,
    );
  });
});
