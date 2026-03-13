import assert from "node:assert/strict";
import { resolve } from "node:path";
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

  it("should accept valid IDs with hyphens and underscores", () => {
    for (const id of ["my-ext", "my_ext", "ext123", "0-start"]) {
      const manifest = createExtension({
        id,
        name: "Test",
        version: "1",
        routes: () => new Hono(),
      });
      assert.equal(manifest.id, id);
    }
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

  it("should throw when id contains path traversal characters", () => {
    assert.throws(
      () =>
        createExtension({
          id: "../evil",
          name: "X",
          version: "1",
          routes: () => new Hono(),
        }),
      /must be lowercase alphanumeric/,
    );
  });

  it("should throw when id contains slashes", () => {
    assert.throws(
      () =>
        createExtension({
          id: "foo/bar",
          name: "X",
          version: "1",
          routes: () => new Hono(),
        }),
      /must be lowercase alphanumeric/,
    );
  });

  it("should throw when id contains uppercase", () => {
    assert.throws(
      () =>
        createExtension({
          id: "MyExt",
          name: "X",
          version: "1",
          routes: () => new Hono(),
        }),
      /must be lowercase alphanumeric/,
    );
  });

  it("should throw when id starts with hyphen", () => {
    assert.throws(
      () =>
        createExtension({
          id: "-bad",
          name: "X",
          version: "1",
          routes: () => new Hono(),
        }),
      /must be lowercase alphanumeric/,
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

describe("extension asset path traversal", () => {
  it("boundary-aware check prevents prefix confusion", () => {
    // Simulate the path traversal check from loadExtension
    const assetsDir = "/path/to/assets";

    function isAllowed(filePath: string): boolean {
      return filePath === assetsDir || filePath.startsWith(assetsDir + "/");
    }

    // Normal file access should be allowed
    assert.ok(isAllowed("/path/to/assets/index.html"));
    assert.ok(isAllowed("/path/to/assets/sub/file.js"));
    assert.ok(isAllowed(assetsDir));

    // Prefix confusion attack should be blocked
    assert.ok(!isAllowed("/path/to/assets-evil/secret"));
    assert.ok(!isAllowed("/path/to/assetsXYZ/file"));

    // Path traversal should be blocked (resolve normalizes ..)
    const traversal = resolve(assetsDir, "../../../etc/passwd");
    assert.ok(!isAllowed(traversal));
  });
});
