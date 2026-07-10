import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { readLogTail } from "../packages/daemon/src/lib/util/log-tail.js";

describe("readLogTail", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "log-tail-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true });
  });

  it("returns an empty array for a missing file (benign ENOENT)", () => {
    assert.deepEqual(readLogTail(join(dir, "nope.log")), []);
  });

  it("surfaces a non-ENOENT read error instead of pretending the log is empty", () => {
    // Reading a directory throws EISDIR — a real failure that must not be swallowed.
    const subdir = join(dir, "a-directory");
    mkdirSync(subdir);
    const result = readLogTail(subdir);
    assert.equal(result.length, 1);
    assert.match(result[0], /could not read .*a-directory/);
  });

  it("returns all lines when fewer than maxLines", () => {
    const p = join(dir, "test.log");
    writeFileSync(p, "one\ntwo\nthree\n");
    assert.deepEqual(readLogTail(p, 10), ["one", "two", "three"]);
  });

  it("returns only the last maxLines", () => {
    const p = join(dir, "test.log");
    writeFileSync(p, ["a", "b", "c", "d", "e"].join("\n"));
    assert.deepEqual(readLogTail(p, 2), ["d", "e"]);
  });

  it("ignores blank lines (including a trailing newline)", () => {
    const p = join(dir, "test.log");
    writeFileSync(p, "first\n\n  \nlast\n");
    assert.deepEqual(readLogTail(p, 10), ["first", "last"]);
  });

  it("surfaces an error line written to the log", () => {
    const p = join(dir, "daemon.log");
    writeFileSync(p, "starting up\nError: EADDRINUSE: address already in use :::1618\n");
    const tail = readLogTail(p, 20);
    assert.ok(tail.some((l) => l.includes("EADDRINUSE")));
  });
});
