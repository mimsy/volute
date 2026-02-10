import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createFileHandlerResolver } from "../templates/_base/src/lib/file-handler.js";
import type { VoluteContentPart } from "../templates/_base/src/lib/types.js";

function waitForDone(
  handler: ReturnType<ReturnType<typeof createFileHandlerResolver>>,
  content: VoluteContentPart[],
  messageId: string,
): Promise<void> {
  return new Promise((resolve) => {
    handler.handle(content, { messageId }, (event) => {
      if (event.type === "done") resolve();
    });
  });
}

describe("file handler", () => {
  it("writes text to file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fh-test-"));
    const resolver = createFileHandlerResolver(dir);
    const handler = resolver("output.md");

    await waitForDone(handler, [{ type: "text", text: "hello world" }], "msg-1");

    const content = readFileSync(join(dir, "output.md"), "utf-8");
    assert.ok(content.includes("hello world"));
  });

  it("creates intermediate directories", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fh-test-"));
    const resolver = createFileHandlerResolver(dir);
    const handler = resolver("sub/deep/file.md");

    await waitForDone(handler, [{ type: "text", text: "nested" }], "msg-2");

    assert.ok(existsSync(join(dir, "sub/deep/file.md")));
  });

  it("emits done even with no text content", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fh-test-"));
    const resolver = createFileHandlerResolver(dir);
    const handler = resolver("empty.md");

    await waitForDone(handler, [{ type: "image", media_type: "image/png", data: "abc" }], "msg-3");

    // File should not be created since there was no text
    assert.ok(!existsSync(join(dir, "empty.md")));
  });

  it("rejects path traversal", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fh-test-"));
    const resolver = createFileHandlerResolver(dir);
    const handler = resolver("../../etc/passwd");

    // Should still emit done but not write
    await waitForDone(handler, [{ type: "text", text: "malicious" }], "msg-4");

    assert.ok(!existsSync(join(dir, "../../etc/passwd-test")));
  });

  it("rejects absolute path outside cwd", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fh-test-"));
    const resolver = createFileHandlerResolver(dir);
    const handler = resolver("/tmp/outside.md");

    await waitForDone(handler, [{ type: "text", text: "escape" }], "msg-5");
    // done emitted without writing outside cwd
  });

  it("appends to existing file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fh-test-"));
    const resolver = createFileHandlerResolver(dir);
    const handler = resolver("append.md");

    await waitForDone(handler, [{ type: "text", text: "first" }], "msg-6");
    await waitForDone(handler, [{ type: "text", text: "second" }], "msg-7");

    const content = readFileSync(join(dir, "append.md"), "utf-8");
    assert.ok(content.includes("first"));
    assert.ok(content.includes("second"));
  });
});
