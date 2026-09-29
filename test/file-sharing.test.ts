import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  acceptPending,
  deliverFile,
  listPending,
  rejectPending,
  stageFile,
  validateFilePath,
} from "../packages/daemon/src/lib/chat/file-sharing.js";
import { voluteHome } from "../packages/daemon/src/lib/mind/registry.js";

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

    it("acceptPending delivers file and removes staging", async () => {
      const name = "stage-accept";
      const dir = setup(name);
      const content = Buffer.from("accepted content");
      const { id } = stageFile(name, "alice", "doc.txt", content, "doc.txt");

      const result = await acceptPending(name, id, dir);
      assert.equal(result.sender, "alice");
      assert.equal(result.filename, "doc.txt");
      assert.equal(result.destPath, "inbox/alice/doc.txt");

      // File should be in inbox
      const delivered = readFileSync(resolve(dir, "home", "inbox", "alice", "doc.txt"));
      assert.deepEqual(delivered, content);

      // Staging should be gone
      assert.equal(listPending(name).length, 0);
    });

    it("acceptPending with custom dest", async () => {
      const name = "stage-custom-dest";
      const dir = setup(name);
      const content = Buffer.from("custom dest content");
      const { id } = stageFile(name, "bob", "file.md", content, "file.md");

      const result = await acceptPending(name, id, dir, "incoming");
      assert.equal(result.destPath, "incoming/bob/file.md");
      assert.ok(existsSync(resolve(dir, "home", "incoming", "bob", "file.md")));
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

    it("acceptPending throws for unknown id", async () => {
      const name = "stage-404";
      const dir = setup(name);
      await assert.rejects(acceptPending(name, "nonexistent", dir), /not found/i);
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

    it("stageFile rejects sender with path separators", () => {
      const name = "stage-sender-slash";
      setup(name);
      assert.throws(
        () => stageFile(name, "alice/../bob", "file.txt", Buffer.from("x"), "file.txt"),
        /sender/i,
      );
    });

    it("acceptPending rejects id with path traversal", async () => {
      const name = "accept-id-traversal";
      const dir = setup(name);
      await assert.rejects(acceptPending(name, "../../etc", dir), /invalid pending file id/i);
    });

    it("rejectPending rejects id with path traversal", () => {
      const name = "reject-id-traversal";
      setup(name);
      assert.throws(() => rejectPending(name, "../../../tmp"), /invalid pending file id/i);
    });
  });

  describe("deliverFile", () => {
    it("delivers file to inbox", async () => {
      const dir = setup("deliver-basic");
      const content = Buffer.from("file content");
      const dest = await deliverFile(dir, "alice", "readme.md", content, undefined, null);
      assert.equal(dest, "inbox/alice/readme.md");
      assert.ok(existsSync(resolve(dir, "home", "inbox", "alice", "readme.md")));
      assert.deepEqual(readFileSync(resolve(dir, "home", "inbox", "alice", "readme.md")), content);
    });

    it("delivers to custom inbox path", async () => {
      const dir = setup("deliver-custom");
      const dest = await deliverFile(
        dir,
        "bob",
        "data.csv",
        Buffer.from("1,2,3"),
        "received",
        null,
      );
      assert.equal(dest, "received/bob/data.csv");
    });

    it("rejects path traversal in filename", async () => {
      const dir = setup("deliver-traversal");
      await assert.rejects(
        deliverFile(dir, "alice", "../evil.txt", Buffer.from("x"), undefined, null),
        /traversal/i,
      );
    });

    it("rejects path traversal in inboxPath", async () => {
      const dir = setup("deliver-inbox-traversal");
      await assert.rejects(
        deliverFile(dir, "alice", "readme.md", Buffer.from("x"), "../../etc", null),
        /inboxPath/i,
      );
    });

    it("rejects sender with path separators", async () => {
      const dir = setup("deliver-sender-slash");
      await assert.rejects(
        deliverFile(dir, "alice/../../etc", "readme.md", Buffer.from("x"), undefined, null),
        /sender/i,
      );
    });

    // The receiver owns home/ and the daemon may be root (#1167): a link it plants on
    // the way to its inbox must not aim the daemon's write elsewhere.
    it("refuses an inbox the receiver linked out of its tree, writing nothing there", async () => {
      const dir = setup("deliver-linked-inbox");
      const elsewhere = mkdtempSync(resolve(tmpdir(), "deliver-elsewhere-"));
      try {
        mkdirSync(resolve(dir, "home"), { recursive: true });
        symlinkSync(elsewhere, resolve(dir, "home", "inbox"));
        await assert.rejects(
          deliverFile(dir, "alice", "readme.md", Buffer.from("x"), undefined, null),
        );
        assert.deepEqual(readdirSync(elsewhere), []);
      } finally {
        rmSync(elsewhere, { recursive: true, force: true });
      }
    });

    it("refuses a symlink planted at the delivered file's name", async () => {
      const dir = setup("deliver-linked-file");
      const outside = resolve(dir, "outside");
      writeFileSync(outside, "untouched");
      mkdirSync(resolve(dir, "home", "inbox", "alice"), { recursive: true });
      symlinkSync(outside, resolve(dir, "home", "inbox", "alice", "readme.md"));
      await assert.rejects(
        deliverFile(dir, "alice", "readme.md", Buffer.from("x"), undefined, null),
      );
      assert.equal(readFileSync(outside, "utf-8"), "untouched");
    });
  });

  describe("listPending returns empty when no state dir", () => {
    it("returns empty array", () => {
      const pending = listPending("nonexistent-mind");
      assert.deepEqual(pending, []);
    });
  });
});
