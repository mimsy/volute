import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  acceptPending,
  addTrust,
  deliverFile,
  isTrustedSender,
  listPending,
  readFileSharingConfig,
  rejectPending,
  removeTrust,
  stageFile,
  validateFilePath,
  writeFileSharingConfig,
} from "../src/lib/file-sharing.js";
import { voluteHome } from "../src/lib/registry.js";

function makeMindDir(name: string): string {
  const dir = resolve(voluteHome(), "minds", name);
  mkdirSync(resolve(dir, "home", ".config"), { recursive: true });
  return dir;
}

function makeStateDir(name: string): void {
  mkdirSync(resolve(voluteHome(), "state", name), { recursive: true });
}

describe("file-sharing", () => {
  const testMinds: string[] = [];

  afterEach(() => {
    for (const name of testMinds) {
      const dir = resolve(voluteHome(), "minds", name);
      if (existsSync(dir)) rmSync(dir, { recursive: true });
      const state = resolve(voluteHome(), "state", name);
      if (existsSync(state)) rmSync(state, { recursive: true });
    }
    testMinds.length = 0;
  });

  function setup(name: string): string {
    testMinds.push(name);
    makeStateDir(name);
    return makeMindDir(name);
  }

  describe("validateFilePath", () => {
    it("rejects empty path", () => {
      assert.ok(validateFilePath(""));
    });

    it("rejects absolute paths", () => {
      assert.ok(validateFilePath("/etc/passwd"));
    });

    it("rejects path traversal", () => {
      assert.ok(validateFilePath("../etc/passwd"));
      assert.ok(validateFilePath("foo/../../etc/passwd"));
    });

    it("accepts normal relative paths", () => {
      assert.equal(validateFilePath("notes.md"), null);
      assert.equal(validateFilePath("docs/readme.txt"), null);
    });
  });

  describe("config read/write", () => {
    it("returns empty config when no file exists", () => {
      const dir = setup("cfg-empty");
      const config = readFileSharingConfig(dir);
      assert.deepEqual(config, {});
    });

    it("round-trips config", () => {
      const dir = setup("cfg-roundtrip");
      const config = { trustedSenders: ["alice", "bob"], inboxPath: "incoming" };
      writeFileSharingConfig(dir, config);
      const loaded = readFileSharingConfig(dir);
      assert.deepEqual(loaded, config);
    });
  });

  describe("trust", () => {
    it("returns false for untrusted sender", () => {
      const dir = setup("trust-none");
      assert.equal(isTrustedSender(dir, "alice"), false);
    });

    it("returns true for trusted sender", () => {
      const dir = setup("trust-yes");
      writeFileSharingConfig(dir, { trustedSenders: ["alice"] });
      assert.equal(isTrustedSender(dir, "alice"), true);
    });

    it("addTrust adds sender", () => {
      const dir = setup("trust-add");
      addTrust(dir, "alice");
      assert.equal(isTrustedSender(dir, "alice"), true);
    });

    it("addTrust is idempotent", () => {
      const dir = setup("trust-add-idem");
      addTrust(dir, "alice");
      addTrust(dir, "alice");
      const config = readFileSharingConfig(dir);
      assert.equal(config.trustedSenders!.filter((s) => s === "alice").length, 1);
    });

    it("removeTrust removes sender", () => {
      const dir = setup("trust-remove");
      addTrust(dir, "alice");
      removeTrust(dir, "alice");
      assert.equal(isTrustedSender(dir, "alice"), false);
    });
  });

  describe("staging and pending", () => {
    it("stageFile + listPending", () => {
      const name = "stage-list";
      setup(name);
      const content = Buffer.from("hello world");
      const { id } = stageFile(name, "alice", "notes.md", content, "notes.md");
      assert.ok(id.startsWith("alice-"));

      const pending = listPending(name);
      assert.equal(pending.length, 1);
      assert.equal(pending[0].sender, "alice");
      assert.equal(pending[0].filename, "notes.md");
      assert.equal(pending[0].size, content.length);
    });

    it("acceptPending delivers file and removes staging", () => {
      const name = "stage-accept";
      const dir = setup(name);
      const content = Buffer.from("accepted content");
      const { id } = stageFile(name, "alice", "doc.txt", content, "doc.txt");

      const result = acceptPending(name, id, dir);
      assert.equal(result.sender, "alice");
      assert.equal(result.filename, "doc.txt");
      assert.equal(result.destPath, "inbox/alice/doc.txt");

      // File should be in inbox
      const delivered = readFileSync(resolve(dir, "home", "inbox", "alice", "doc.txt"));
      assert.deepEqual(delivered, content);

      // Staging should be gone
      assert.equal(listPending(name).length, 0);
    });

    it("rejectPending removes staging", () => {
      const name = "stage-reject";
      setup(name);
      const { id } = stageFile(name, "alice", "spam.txt", Buffer.from("spam"), "spam.txt");

      const result = rejectPending(name, id);
      assert.equal(result.sender, "alice");
      assert.equal(result.filename, "spam.txt");
      assert.equal(listPending(name).length, 0);
    });

    it("acceptPending throws for unknown id", () => {
      const name = "stage-404";
      const dir = setup(name);
      assert.throws(() => acceptPending(name, "nonexistent", dir), /not found/i);
    });

    it("rejectPending throws for unknown id", () => {
      const name = "reject-404";
      setup(name);
      assert.throws(() => rejectPending(name, "nonexistent"), /not found/i);
    });

    it("stageFile rejects path traversal", () => {
      const name = "stage-traversal";
      setup(name);
      assert.throws(
        () => stageFile(name, "alice", "../evil.txt", Buffer.from("x"), "../evil.txt"),
        /traversal/i,
      );
    });

    it("acceptPending uses custom inboxPath", () => {
      const name = "stage-custom-inbox";
      const dir = setup(name);
      writeFileSharingConfig(dir, { inboxPath: "incoming" });

      const { id } = stageFile(name, "bob", "file.md", Buffer.from("data"), "file.md");
      const result = acceptPending(name, id, dir);
      assert.equal(result.destPath, "incoming/bob/file.md");
      assert.ok(existsSync(resolve(dir, "home", "incoming", "bob", "file.md")));
    });
  });

  describe("deliverFile", () => {
    it("delivers file to inbox", () => {
      const dir = setup("deliver-basic");
      const content = Buffer.from("file content");
      const dest = deliverFile(dir, "alice", "readme.md", content);
      assert.equal(dest, "inbox/alice/readme.md");
      assert.ok(existsSync(resolve(dir, "home", "inbox", "alice", "readme.md")));
      assert.deepEqual(readFileSync(resolve(dir, "home", "inbox", "alice", "readme.md")), content);
    });

    it("delivers to custom inbox path", () => {
      const dir = setup("deliver-custom");
      const dest = deliverFile(dir, "bob", "data.csv", Buffer.from("1,2,3"), "received");
      assert.equal(dest, "received/bob/data.csv");
    });

    it("rejects path traversal in filename", () => {
      const dir = setup("deliver-traversal");
      assert.throws(() => deliverFile(dir, "alice", "../evil.txt", Buffer.from("x")), /traversal/i);
    });
  });

  describe("listPending returns empty when no state dir", () => {
    it("returns empty array", () => {
      const pending = listPending("nonexistent-mind");
      assert.deepEqual(pending, []);
    });
  });
});
