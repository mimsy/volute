import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { RotatingLog } from "../src/lib/rotating-log.js";

function write(log: RotatingLog, data: string): Promise<void> {
  return new Promise((resolve, reject) => {
    log.write(data, (err) => (err ? reject(err) : resolve()));
  });
}

function end(log: RotatingLog): Promise<void> {
  return new Promise((resolve) => log.end(resolve));
}

describe("RotatingLog", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rotating-log-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true });
  });

  it("writes data to the log file", async () => {
    const logPath = join(dir, "test.log");
    const log = new RotatingLog(logPath);
    await write(log, "hello\n");
    await end(log);
    assert.equal(readFileSync(logPath, "utf-8"), "hello\n");
  });

  it("appends to existing file across instances", async () => {
    const logPath = join(dir, "test.log");
    const log1 = new RotatingLog(logPath);
    await write(log1, "first\n");
    await end(log1);

    const log2 = new RotatingLog(logPath);
    await write(log2, "second\n");
    await end(log2);

    assert.equal(readFileSync(logPath, "utf-8"), "first\nsecond\n");
  });

  it("rotates when file exceeds maxSize", async () => {
    const logPath = join(dir, "test.log");
    const log = new RotatingLog(logPath, 20);
    await write(log, "1234567890"); // 10 bytes
    await write(log, "1234567890"); // 20 bytes total
    await write(log, "new"); // 23 bytes, triggers rotation
    await end(log);

    assert(existsSync(`${logPath}.1`));
    assert.equal(readFileSync(logPath, "utf-8"), "new");
    assert.equal(readFileSync(`${logPath}.1`, "utf-8"), "12345678901234567890");
  });

  it("tracks size across instances for rotation", async () => {
    const logPath = join(dir, "test.log");
    const log1 = new RotatingLog(logPath, 20);
    await write(log1, "1234567890"); // 10 bytes
    await end(log1);

    const log2 = new RotatingLog(logPath, 20);
    await write(log2, "1234567890"); // 20 bytes total
    await write(log2, "overflow"); // triggers rotation
    await end(log2);

    assert(existsSync(`${logPath}.1`));
    assert.equal(readFileSync(logPath, "utf-8"), "overflow");
  });

  it("does not crash if rotation fails", async () => {
    const logPath = join(dir, "test.log");
    const log = new RotatingLog(logPath, 5);
    // Write enough to trigger rotation, then continue writing
    await write(log, "123456"); // triggers rotation
    await write(log, "789"); // should still work
    await end(log);
    // Just verify it didn't throw
    assert(existsSync(logPath));
  });

  it("produces multiple rotated files (.1, .2, etc.)", async () => {
    const logPath = join(dir, "test.log");
    // maxSize=10, maxFiles=5 — each chunk triggers rotation on its own
    const log = new RotatingLog(logPath, 10, 5);
    await write(log, "aaaaaaaaaa"); // 10 bytes, size=10, no rotation yet
    await write(log, "bbbbbbbbbbb"); // 11 bytes, size=21, rotation: current→.1, write to new
    await write(log, "ccccccccccc"); // 11 bytes, rotation: .1→.2, current→.1
    await end(log);

    assert(existsSync(`${logPath}.1`), ".1 should exist");
    assert(existsSync(`${logPath}.2`), ".2 should exist");
    assert.equal(readFileSync(logPath, "utf-8"), "ccccccccccc");
    assert.equal(readFileSync(`${logPath}.1`, "utf-8"), "bbbbbbbbbbb");
    assert.equal(readFileSync(`${logPath}.2`, "utf-8"), "aaaaaaaaaa");
  });

  it("deletes oldest file when maxFiles exceeded", async () => {
    const logPath = join(dir, "test.log");
    // maxFiles=2 means we keep current + .1 + .2
    const log = new RotatingLog(logPath, 5, 2);
    await write(log, "aaaaaa"); // 6 bytes, triggers rotation → .1
    await write(log, "bbbbbb"); // triggers rotation → .1 shifts to .2, current → .1
    await write(log, "cccccc"); // triggers rotation → .2 deleted, .1 → .2, current → .1
    await end(log);

    assert(existsSync(`${logPath}.1`), ".1 should exist");
    assert(existsSync(`${logPath}.2`), ".2 should exist");
    assert(!existsSync(`${logPath}.3`), ".3 should not exist (maxFiles=2)");
    assert.equal(readFileSync(logPath, "utf-8"), "cccccc");
    assert.equal(readFileSync(`${logPath}.1`, "utf-8"), "bbbbbb");
    assert.equal(readFileSync(`${logPath}.2`, "utf-8"), "aaaaaa");
  });

  it("maxFiles=1 keeps only one rotated file", async () => {
    const logPath = join(dir, "test.log");
    const log = new RotatingLog(logPath, 5, 1);
    await write(log, "aaaaaa"); // triggers rotation → .1
    await write(log, "bbbbbb"); // triggers rotation → .1 deleted, current → .1
    await end(log);

    assert(existsSync(`${logPath}.1`), ".1 should exist");
    assert(!existsSync(`${logPath}.2`), ".2 should not exist (maxFiles=1)");
  });
});
