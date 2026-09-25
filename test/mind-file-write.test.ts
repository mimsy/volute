import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import {
  mindAnchor,
  readMindFile,
  writeMindFile,
} from "../packages/daemon/src/lib/mind/mind-file-write.js";

const execFileAsync = promisify(execFile);

function scratch(label: string): string {
  return mkdtempSync(resolve(tmpdir(), `mind-file-write-${label}-`));
}

describe("writeMindFile", () => {
  it("creates missing directories and the file", async () => {
    const dir = scratch("create");
    assert.equal(await writeMindFile(dir, "home/a/b/f.txt", "hi", { owner: null }), true);
    assert.equal(readFileSync(resolve(dir, "home/a/b/f.txt"), "utf-8"), "hi");
  });

  it('create: "if-absent" leaves a file the mind already has alone', async () => {
    const dir = scratch("if-absent");
    mkdirSync(resolve(dir, "home"));
    writeFileSync(resolve(dir, "home/f"), "mine");
    const opts = { owner: null, create: "if-absent" as const };
    assert.equal(await writeMindFile(dir, "home/f", "default", opts), false);
    assert.equal(readFileSync(resolve(dir, "home/f"), "utf-8"), "mine");
    assert.equal(await writeMindFile(dir, "home/g", "default", opts), true);
    assert.equal(readFileSync(resolve(dir, "home/g"), "utf-8"), "default");
  });

  it("create: false leaves an absent file (and its directory) absent", async () => {
    const dir = scratch("no-create");
    assert.equal(await writeMindFile(dir, "home/x/f", "x", { owner: null, create: false }), false);
    assert.equal(existsSync(resolve(dir, "home")), false);
  });

  it("refuses to read back a file larger than the cap", async () => {
    const dir = scratch("cap");
    mkdirSync(resolve(dir, "home"));
    writeFileSync(resolve(dir, "home/f"), Buffer.alloc(1024 * 1024 + 1));
    await assert.rejects(
      writeMindFile(dir, "home/f", (cur) => cur, { owner: null }),
      /larger/,
    );
    await assert.rejects(readMindFile(dir, "home/f", { owner: null }), /larger/);
    // Replacing it outright reads nothing, so there is nothing to cap.
    assert.equal(await writeMindFile(dir, "home/f", "small", { owner: null }), true);
  });

  it("hands produce the current text and replaces it whole", async () => {
    const dir = scratch("rmw");
    mkdirSync(resolve(dir, "home"));
    writeFileSync(resolve(dir, "home/f"), "a much longer original");
    await writeMindFile(dir, "home/f", (cur) => `${cur.length}`, { owner: null });
    assert.equal(readFileSync(resolve(dir, "home/f"), "utf-8"), "22");
  });

  it("follows a directory link that stays inside the mind dir", async () => {
    const dir = scratch("inner-link");
    mkdirSync(resolve(dir, "home/art"), { recursive: true });
    symlinkSync(resolve(dir, "home/art"), resolve(dir, "home/images"));
    await writeMindFile(dir, "home/images/x.png", () => "png", { owner: null });
    assert.equal(readFileSync(resolve(dir, "home/art/x.png"), "utf-8"), "png");
  });

  it("refuses a directory link out of the mind dir, creating nothing there", async () => {
    const dir = scratch("outer-link");
    const outside = scratch("outside");
    mkdirSync(resolve(dir, "home"));
    symlinkSync(outside, resolve(dir, "home/images"));
    await assert.rejects(
      writeMindFile(dir, "home/images/sub/x.png", () => "png", { owner: null }),
      /escapes base directory/,
    );
    assert.deepEqual(readdirSync(outside), [], "nothing may be created through the link");
  });

  it("refuses a dangling link at a missing directory", async () => {
    const dir = scratch("dangling");
    const outside = scratch("dangling-target");
    mkdirSync(resolve(dir, "home"));
    symlinkSync(resolve(outside, "not-yet"), resolve(dir, "home/.claude"));
    await assert.rejects(
      writeMindFile(dir, "home/.claude/f", () => "x", { owner: null }),
      /a link to nothing/,
    );
    assert.throws(() => statSync(resolve(outside, "not-yet")), /ENOENT/);
  });

  it("refuses a symlink at the file itself", async () => {
    const dir = scratch("file-link");
    const victim = resolve(scratch("victim"), "v");
    writeFileSync(victim, "untouched");
    mkdirSync(resolve(dir, "home"));
    symlinkSync(victim, resolve(dir, "home/f"));
    await assert.rejects(
      writeMindFile(dir, "home/f", () => "x", { owner: null }),
      /not a regular file/,
    );
    assert.equal(readFileSync(victim, "utf-8"), "untouched");
  });

  it("refuses a hard link to a file elsewhere, before truncating it", async () => {
    const dir = scratch("hardlink");
    const victim = resolve(scratch("hl-victim"), "v");
    writeFileSync(victim, "untouched");
    mkdirSync(resolve(dir, "home"));
    linkSync(victim, resolve(dir, "home/f"));
    await assert.rejects(
      writeMindFile(dir, "home/f", () => "x", { owner: null }),
      /single link/,
    );
    assert.equal(readFileSync(victim, "utf-8"), "untouched");
  });

  it("refuses a FIFO with no reader instead of hanging", async () => {
    const dir = scratch("fifo");
    mkdirSync(resolve(dir, "home"));
    await execFileAsync("mkfifo", [resolve(dir, "home/f")]);
    const write = writeMindFile(dir, "home/f", () => "x", { owner: null });
    const hung = new Promise((r) => setTimeout(() => r("hung"), 2000).unref());
    const outcome = await Promise.race([
      write.then(
        () => "wrote",
        () => "refused",
      ),
      hung,
    ]);
    assert.equal(outcome, "refused");
  });

  // Under isolation `owner` is the mind's; a non-root test can still observe the
  // handle chown by moving the file to another group it belongs to.
  it("chowns the file and the directories it created to owner", async (t) => {
    const dir = scratch("chown");
    mkdirSync(resolve(dir, "home"));
    const uid = process.getuid?.();
    // Not the group a new file would get anyway: the process's (Linux) or the
    // parent directory's (macOS).
    const usual = [process.getgid?.(), statSync(resolve(dir, "home")).gid];
    const other = process.getgroups?.().find((g) => !usual.includes(g));
    if (uid === undefined || other === undefined) {
      t.skip("needs a second group to observe the chown");
      return;
    }
    await writeMindFile(dir, "home/new/f", () => "x", { owner: { uid, gid: other } });
    assert.equal(statSync(resolve(dir, "home/new/f")).gid, other);
    assert.equal(statSync(resolve(dir, "home/new")).gid, other);
    assert.notEqual(statSync(resolve(dir, "home")).gid, other, "an existing dir is left alone");
  });

  it("leaves no file behind when content declines to write a new one", async () => {
    const dir = scratch("null-new");
    assert.equal(await writeMindFile(dir, "home/f", () => null, { owner: null }), false);
    assert.equal(existsSync(resolve(dir, "home/f")), false);
    await assert.rejects(
      writeMindFile(
        dir,
        "home/g",
        () => {
          throw new Error("boom");
        },
        { owner: null },
      ),
      /boom/,
    );
    assert.equal(existsSync(resolve(dir, "home/g")), false);
  });

  it("hands a new file to owner before content runs", async (t) => {
    const dir = scratch("chown-first");
    mkdirSync(resolve(dir, "home"));
    const uid = process.getuid?.();
    const usual = [process.getgid?.(), statSync(resolve(dir, "home")).gid];
    const other = process.getgroups?.().find((g) => !usual.includes(g));
    if (uid === undefined || other === undefined) {
      t.skip("needs a second group to observe the chown");
      return;
    }
    let gidDuring: number | undefined;
    await writeMindFile(
      dir,
      "home/f",
      () => {
        gidDuring = statSync(resolve(dir, "home/f")).gid;
        return "x";
      },
      { owner: { uid, gid: other } },
    );
    assert.equal(gidDuring, other);
  });

  it("hands a directory it created to owner even when the write then fails", async (t) => {
    const dir = scratch("chown-fail");
    mkdirSync(resolve(dir, "home"));
    const uid = process.getuid?.();
    const usual = [process.getgid?.(), statSync(resolve(dir, "home")).gid];
    const other = process.getgroups?.().find((g) => !usual.includes(g));
    if (uid === undefined || other === undefined) {
      t.skip("needs a second group to observe the chown");
      return;
    }
    const failing = () => {
      throw new Error("boom");
    };
    await assert.rejects(
      writeMindFile(dir, "home/new/f", failing, { owner: { uid, gid: other } }),
      /boom/,
    );
    assert.equal(statSync(resolve(dir, "home/new")).gid, other);
  });

  // A variant lives in its parent's .variants/, which the parent owns and can swap for a
  // link into another mind's tree; with an owner, the anchor is the owner's topmost dir,
  // not the variant dir's own real path. Built under /tmp, whose ancestors this user does
  // not own, so "topmost dir the owner owns" is the scratch root — as a minds root would be.
  it("refuses a variant dir its parent swapped for a link to another mind", async (t) => {
    const uid = process.getuid?.();
    const gid = process.getgid?.();
    if (uid === undefined || gid === undefined) {
      t.skip("needs POSIX uids");
      return;
    }
    const parent = mkdtempSync("/tmp/mind-file-write-parent-");
    const other = mkdtempSync("/tmp/mind-file-write-other-");
    mkdirSync(resolve(other, "home"));
    mkdirSync(resolve(parent, ".variants"));
    symlinkSync(other, resolve(parent, ".variants/v"));
    await assert.rejects(
      writeMindFile(resolve(parent, ".variants/v"), "home/.zshenv", "token", {
        owner: { uid, gid },
      }),
      /escapes base directory/,
    );
    assert.equal(existsSync(resolve(other, "home/.zshenv")), false);
  });
});

describe("writeMindFile under concurrency", () => {
  // Up to four imagegen jobs per mind, and the mind itself, can race to create
  // home/images: losing the mkdir race is not a planted link.
  it("lets concurrent writers all create files in a directory none of them found", async () => {
    const dir = scratch("race-mkdir");
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        writeMindFile(dir, `home/images/deep/${i}.png`, "png", { owner: null }),
      ),
    );
    assert.deepEqual(results, Array(8).fill(true));
  });

  // A restart and the refresh fan-out can both set a provider in the same auth.json.
  it("serializes read-modify-writes of one file, so none is lost or spliced", async () => {
    const dir = scratch("race-rmw");
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        writeMindFile(
          dir,
          "home/auth.json",
          (cur) => JSON.stringify({ ...(cur ? JSON.parse(cur) : {}), [`p${i}`]: i }),
          { owner: null },
        ),
      ),
    );
    const auth = JSON.parse(readFileSync(resolve(dir, "home/auth.json"), "utf-8"));
    assert.equal(Object.keys(auth).length, 10);
  });
});

describe("mindAnchor", () => {
  // With an owner who owns nothing on the path (a dir not handed over yet),
  // containMindPath answers lexically; the anchor must still be the real path, or a
  // mind dir behind a linked prefix (/var -> /private/var, /minds -> /data/minds)
  // refuses every write. A non-root test can't write as a foreign owner, so this
  // checks the anchor directly.
  it("is the real path even when no ancestor belongs to the owner", async () => {
    const real = scratch("anchor-real");
    mkdirSync(resolve(real, "m"));
    const linked = resolve(scratch("anchor-link"), "minds");
    symlinkSync(real, linked);
    const owner = { uid: 2147483000, gid: 2147483000 };
    assert.equal(await mindAnchor(resolve(linked, "m"), owner), realpathSync(resolve(real, "m")));
  });

  // A host that keeps a mind dir elsewhere and links it in (/minds/foo -> /data/foo).
  it("is the real path when the mind dir itself is a host's link", async () => {
    const real = scratch("anchor-host-real");
    const link = resolve(scratch("anchor-host"), "foo");
    symlinkSync(real, link);
    const owner = { uid: 2147483000, gid: 2147483000 };
    assert.equal(await mindAnchor(link, owner), realpathSync(real));
  });
});

describe("readMindFile", () => {
  it("returns null for an absent file and the text of a present one", async () => {
    const dir = scratch("read");
    assert.equal(await readMindFile(dir, "home/f", { owner: null }), null);
    mkdirSync(resolve(dir, "home"));
    writeFileSync(resolve(dir, "home/f"), "hi");
    assert.equal((await readMindFile(dir, "home/f", { owner: null }))?.text, "hi");
  });

  it("refuses a symlink and a FIFO rather than following or hanging on them", async () => {
    const dir = scratch("read-refuse");
    mkdirSync(resolve(dir, "home"));
    const victim = resolve(scratch("read-victim"), "v");
    writeFileSync(victim, "secret");
    symlinkSync(victim, resolve(dir, "home/link"));
    await execFileAsync("mkfifo", [resolve(dir, "home/fifo")]);
    await assert.rejects(readMindFile(dir, "home/link", { owner: null }), /ELOOP/);
    await assert.rejects(readMindFile(dir, "home/fifo", { owner: null }), /single link/);
  });
});
