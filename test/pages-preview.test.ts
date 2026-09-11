import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { ChownExec, MindOwnership } from "../packages/extensions/pages/src/ownership.js";
import { renderPreview, resolveBrowser } from "../packages/extensions/pages/src/preview.js";

/**
 * Unit coverage for renderPreview's pure/mockable logic — path containment,
 * extension handling, browser resolution, and graceful degradation when no
 * browser is available. The real chromium render is verified end-to-end in
 * Docker, not here; the renderPreview tests point VOLUTE_CHROMIUM at a binary
 * that does not exist so no real browser is ever launched and the error path is
 * exercised deterministically, and resolveBrowser is driven with injected inputs.
 */

const BOGUS_CHROMIUM = resolve(tmpdir(), "definitely-not-a-real-chromium-binary-xyz");

/**
 * Isolation off: `chownToMind` returns before it would shell out, so every test
 * that is not about ownership gets the real code path with no `chown` in it.
 */
const NO_ISOLATION: MindOwnership = {
  isIsolationEnabled: () => false,
  getMindUser: (name) => `mind-${name}`,
};

const isolationOn: MindOwnership = {
  isIsolationEnabled: () => true,
  getMindUser: (name) => `mind-${name}`,
};

/** Stand-in for the daemon's `chown`, so the argv can be asserted without root. */
function recordingExec(): { calls: string[][]; exec: ChownExec } {
  const calls: string[][] = [];
  return {
    calls,
    exec: async (cmd, args) => {
      calls.push([cmd, ...args]);
    },
  };
}

/**
 * A browser that is not a browser: reads `--screenshot=<path>` out of its own argv
 * and writes a file there. Lets the success path — which is where the PNG gets
 * chowned — run on a host with no chromium and with no 30s render.
 *
 * `plant` stands in for the mind winning the race the renderer has to survive: a
 * symlink appearing at the image's own name *while the browser is running*, after
 * every check the renderer could have made. The stub creates it, then writes its
 * output, exactly as a real render would.
 */
function writeStubBrowser(dir: string, plant?: { at: string; target: string }): string {
  const path = resolve(dir, `stub-browser-${stubSeq++}.sh`);
  writeFileSync(
    path,
    [
      "#!/bin/sh",
      ...(plant ? [`ln -sf '${plant.target}' '${plant.at}'`] : []),
      "out=",
      'for a in "$@"; do',
      '  case "$a" in',
      `    --screenshot=*) out=$(printf %s "$a" | sed 's/^--screenshot=//') ;;`,
      "  esac",
      "done",
      '[ -n "$out" ] && printf PNG > "$out"',
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(path, 0o755);
  return path;
}

let stubSeq = 0;

let mindDir: string;
let pagesRoot: string;
let prevChromium: string | undefined;

beforeEach(() => {
  mindDir = mkdtempSync(resolve(tmpdir(), "preview-test-"));
  pagesRoot = resolve(mindDir, "home", "pages");
  mkdirSync(pagesRoot, { recursive: true });
  prevChromium = process.env.VOLUTE_CHROMIUM;
  process.env.VOLUTE_CHROMIUM = BOGUS_CHROMIUM;
});

afterEach(() => {
  if (prevChromium === undefined) delete process.env.VOLUTE_CHROMIUM;
  else process.env.VOLUTE_CHROMIUM = prevChromium;
  rmSync(mindDir, { recursive: true, force: true });
});

describe("renderPreview path containment", () => {
  it("rejects a parent-relative escape", async () => {
    writeFileSync(resolve(mindDir, "home", "secret.html"), "<h1>secret</h1>");
    const result = await renderPreview({
      mindDir,
      mindName: "testmind",
      ownership: NO_ISOLATION,
      file: "../secret.html",
    });
    assert.deepEqual(result, { error: "Page path must stay within pages/." });
  });

  it("rejects an absolute path", async () => {
    const result = await renderPreview({
      mindDir,
      mindName: "testmind",
      ownership: NO_ISOLATION,
      file: "/etc/passwd",
    });
    assert.deepEqual(result, { error: "Page path must stay within pages/." });
  });
});

describe("renderPreview extension + existence handling", () => {
  it("returns the draft-it-first error for a missing file", async () => {
    const result = await renderPreview({
      mindDir,
      mindName: "testmind",
      ownership: NO_ISOLATION,
      file: "index.html",
    });
    assert.ok("error" in result);
    assert.match(result.error, /No page at pages\/index\.html/);
    assert.match(result.error, /Draft it in home\/pages\//);
  });

  it("rejects a non-.html/.md file", async () => {
    writeFileSync(resolve(pagesRoot, "notes.txt"), "hello");
    const result = await renderPreview({
      mindDir,
      mindName: "testmind",
      ownership: NO_ISOLATION,
      file: "notes.txt",
    });
    assert.deepEqual(result, { error: "Preview renders .html and .md pages." });
  });
});

describe("renderPreview graceful degradation without a browser", () => {
  it("returns an error (does not throw) for an .html page when chromium is absent", async () => {
    writeFileSync(resolve(pagesRoot, "index.html"), "<!doctype html><h1>hi</h1>");
    const result = await renderPreview({
      mindDir,
      mindName: "testmind",
      ownership: NO_ISOLATION,
      file: "index.html",
    });
    assert.ok("error" in result);
    assert.match(result.error, /Could not render the page/);
    assert.match(result.error, /VOLUTE_CHROMIUM/);
  });

  it("renders the .md branch, then degrades and cleans up the temp html", async () => {
    writeFileSync(resolve(pagesRoot, "about.md"), "---\ntitle: About\n---\n# About me\n");
    const result = await renderPreview({
      mindDir,
      mindName: "testmind",
      ownership: NO_ISOLATION,
      file: "about.md",
    });
    assert.ok("error" in result);
    assert.match(result.error, /Could not render the page/);
    // The transient markdown html is written into pages/ then removed in finally.
    const leftovers = readdirSync(pagesRoot).filter((f) => f.startsWith(".preview-src-"));
    assert.deepEqual(leftovers, [], "temp markdown html should be cleaned up");
  });

  it("does not leave a chromium user-data-dir behind on failure", async () => {
    writeFileSync(resolve(pagesRoot, "index.html"), "<!doctype html><h1>hi</h1>");
    await renderPreview({
      mindDir,
      mindName: "testmind",
      ownership: NO_ISOLATION,
      file: "index.html",
    });
    // chromium never launched (bogus binary), so no /tmp/chromium-* dir was created;
    // the finally block's rmSync is a no-op but must not throw.
    assert.ok(!existsSync(resolve(mindDir, "home", ".preview", "index.png")));
  });

  it("reports 'no browser found' when nothing resolves (linux, empty PATH)", async () => {
    writeFileSync(resolve(pagesRoot, "index.html"), "<!doctype html><h1>hi</h1>");
    // Force the resolver to find nothing regardless of the test host: unset the
    // override, pretend to be linux, and give it an empty PATH.
    delete process.env.VOLUTE_CHROMIUM;
    const prevPath = process.env.PATH;
    const platformDesc = Object.getOwnPropertyDescriptor(process, "platform");
    process.env.PATH = "";
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    try {
      const result = await renderPreview({
        mindDir,
        mindName: "testmind",
        ownership: NO_ISOLATION,
        file: "index.html",
      });
      assert.deepEqual(result, {
        error:
          "No Chrome-family browser found. Install Chrome or Chromium, or set VOLUTE_CHROMIUM to a browser binary.",
      });
    } finally {
      if (platformDesc) Object.defineProperty(process, "platform", platformDesc);
      if (prevPath === undefined) delete process.env.PATH;
      else process.env.PATH = prevPath;
    }
  });
});

describe("resolveBrowser", () => {
  // The outer beforeEach sets VOLUTE_CHROMIUM (which resolveBrowser falls back to
  // when no override is injected); clear it so these tests exercise the injected
  // platform/candidate/exists inputs deterministically.
  beforeEach(() => {
    delete process.env.VOLUTE_CHROMIUM;
  });

  it("returns the VOLUTE_CHROMIUM override verbatim when set", () => {
    const got = resolveBrowser({ override: "/opt/my-chrome", exists: () => false });
    assert.equal(got, "/opt/my-chrome");
  });

  it("picks the first present macOS candidate", () => {
    const present = "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser";
    const got = resolveBrowser({
      override: undefined,
      platform: "darwin",
      macCandidates: ["/Applications/Chrome-missing", present],
      exists: (p) => p === present,
    });
    assert.equal(got, present);
  });

  it("resolves a Linux PATH candidate to its full path", () => {
    const got = resolveBrowser({
      override: undefined,
      platform: "linux",
      pathEnv: "/usr/bin:/usr/local/bin",
      pathCandidates: ["google-chrome", "chromium"],
      exists: (p) => p === "/usr/local/bin/chromium",
    });
    assert.equal(got, "/usr/local/bin/chromium");
  });

  it("returns null when nothing is present", () => {
    assert.equal(
      resolveBrowser({
        override: undefined,
        platform: "linux",
        pathEnv: "/usr/bin",
        exists: () => false,
      }),
      null,
    );
    assert.equal(
      resolveBrowser({ override: undefined, platform: "darwin", exists: () => false }),
      null,
    );
  });
});

/**
 * The daemon reads the page as the daemon — root on a user-isolation install — and
 * the mind owns every directory on the path to it. A page that is really a symlink
 * out of `home/pages` must be refused before it is opened, not read and rendered
 * into an image the mind can then open. The refusal is worded exactly like a plain
 * `../` escape on purpose: where the link landed is the thing not to say.
 */
describe("renderPreview symlink containment", () => {
  const call = (file: string) =>
    renderPreview({ mindDir, mindName: "testmind", ownership: NO_ISOLATION, file });

  it("refuses a page that is a symlink out of pages/ (still inside the mind's dir)", async () => {
    const secret = resolve(mindDir, "home", "secret.html");
    writeFileSync(secret, "<h1>secret</h1>");
    symlinkSync(secret, resolve(pagesRoot, "evil.html"));
    assert.deepEqual(await call("evil.html"), { error: "Page path must stay within pages/." });
  });

  it("refuses a page that is a symlink to a file outside the mind entirely", async () => {
    const outside = mkdtempSync(resolve(tmpdir(), "preview-outside-"));
    const secret = resolve(outside, "host-only.md");
    writeFileSync(secret, "---\ntitle: x\n---\nhost only\n");
    symlinkSync(secret, resolve(pagesRoot, "evil.md"));
    try {
      assert.deepEqual(await call("evil.md"), { error: "Page path must stay within pages/." });
      // The markdown branch is the one that writes a temp file beside the page;
      // refusing before that means nothing was rendered out of the target at all.
      assert.deepEqual(
        readdirSync(pagesRoot).filter((f) => f.startsWith(".preview-src-")),
        [],
      );
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("refuses a page under a symlinked directory inside pages/", async () => {
    const outside = mkdtempSync(resolve(tmpdir(), "preview-outside-"));
    writeFileSync(resolve(outside, "x.html"), "<h1>secret</h1>");
    symlinkSync(outside, resolve(pagesRoot, "notes"));
    try {
      assert.deepEqual(await call("notes/x.html"), { error: "Page path must stay within pages/." });
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("refuses to render when home/.preview is a symlink out of the mind's dir", async () => {
    const outside = mkdtempSync(resolve(tmpdir(), "preview-outside-"));
    writeFileSync(resolve(pagesRoot, "index.html"), "<!doctype html><h1>hi</h1>");
    symlinkSync(outside, resolve(mindDir, "home", ".preview"));
    // A browser that really writes its --screenshot path. With the bogus binary the
    // "nothing landed through the link" assertion would hold no matter what the
    // containment did, and would be proving only that chromium is absent.
    process.env.VOLUTE_CHROMIUM = writeStubBrowser(mindDir);
    try {
      const result = await call("index.html");
      assert.ok("error" in result);
      assert.match(result.error, /Could not prepare the preview/);
      assert.deepEqual(readdirSync(outside), [], "nothing may be written through the link");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("refuses a home/.preview that is a symlink to another directory inside the mind", async () => {
    // Containment alone would wave this through — it never leaves the mind's own
    // directory. It would also drop the render into the mind's published pages.
    writeFileSync(resolve(pagesRoot, "index.html"), "<!doctype html><h1>hi</h1>");
    symlinkSync(pagesRoot, resolve(mindDir, "home", ".preview"));
    process.env.VOLUTE_CHROMIUM = writeStubBrowser(mindDir);

    const result = await call("index.html");

    assert.ok("error" in result);
    assert.match(result.error, /Could not prepare the preview/);
    assert.deepEqual(
      readdirSync(pagesRoot),
      ["index.html"],
      "the render must not land in the mind's pages directory",
    );
  });
});

/**
 * `home/` is the mind's own space. A preview the daemon leaves root-owned is litter
 * the mind is stuck with — unlinking needs write permission on the *directory*, so
 * the directory matters at least as much as the PNG, and a failed render is
 * precisely the run that creates `.preview` and puts nothing in it.
 */
describe("renderPreview ownership handoff", () => {
  it("gives the mind both the .preview dir and the PNG after a successful render", async () => {
    writeFileSync(resolve(pagesRoot, "index.html"), "<!doctype html><h1>hi</h1>");
    process.env.VOLUTE_CHROMIUM = writeStubBrowser(mindDir);
    const { calls, exec } = recordingExec();

    const result = await renderPreview({
      mindDir,
      mindName: "testmind",
      ownership: isolationOn,
      file: "index.html",
      exec,
    });

    assert.ok(!("error" in result), `expected a render, got ${JSON.stringify(result)}`);
    assert.equal(result.rel, "home/.preview/index.png");
    assert.equal(calls.length, 1);
    const [cmd, flag, spec, ...paths] = calls[0];
    assert.equal(cmd, "chown");
    assert.equal(flag, "-h");
    assert.equal(spec, "mind-testmind:volute");
    // Real paths, so the chown can never be aimed through a link the mind planted.
    const realPreviewDir = realpathSync(resolve(mindDir, "home", ".preview"));
    assert.deepEqual(paths, [realPreviewDir, resolve(realPreviewDir, "index.png")]);
  });

  it("clears a stale image when the render fails, rather than passing it off as new", async () => {
    writeFileSync(resolve(pagesRoot, "index.html"), "<!doctype html><h1>hi</h1>");
    process.env.VOLUTE_CHROMIUM = writeStubBrowser(mindDir);
    const first = await renderPreview({
      mindDir,
      mindName: "testmind",
      ownership: NO_ISOLATION,
      file: "index.html",
    });
    assert.ok(!("error" in first));
    assert.ok(existsSync(first.pngPath));

    // Now take the browser away and render the same page again.
    process.env.VOLUTE_CHROMIUM = BOGUS_CHROMIUM;
    const second = await renderPreview({
      mindDir,
      mindName: "testmind",
      ownership: NO_ISOLATION,
      file: "index.html",
    });

    assert.ok("error" in second);
    assert.ok(!existsSync(first.pngPath), "yesterday's render must not survive as today's");
  });

  it("does not write through a symlink planted at the image's own name", async () => {
    const outside = mkdtempSync(resolve(tmpdir(), "preview-outside-"));
    const decoy = resolve(outside, "decoy.txt");
    writeFileSync(decoy, "untouched");
    writeFileSync(resolve(pagesRoot, "index.html"), "<!doctype html><h1>hi</h1>");
    mkdirSync(resolve(mindDir, "home", ".preview"), { recursive: true });
    symlinkSync(decoy, resolve(mindDir, "home", ".preview", "index.png"));
    process.env.VOLUTE_CHROMIUM = writeStubBrowser(mindDir);

    try {
      const result = await renderPreview({
        mindDir,
        mindName: "testmind",
        ownership: NO_ISOLATION,
        file: "index.html",
      });
      assert.ok(!("error" in result), `expected a render, got ${JSON.stringify(result)}`);
      assert.equal(readFileSync(decoy, "utf-8"), "untouched");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("refuses to write through a symlink that appears during the render", async () => {
    // The check-then-write window: containment proved the directory before chromium
    // started, and the mind owns that directory, so it can drop a link at the
    // image's name while the browser is still going. The render is staged outside
    // the mind's reach and moved in with an exclusive create, so the move is
    // refused rather than followed.
    const outside = mkdtempSync(resolve(tmpdir(), "preview-outside-"));
    const decoy = resolve(outside, "decoy.txt");
    writeFileSync(decoy, "untouched");
    writeFileSync(resolve(pagesRoot, "index.html"), "<!doctype html><h1>hi</h1>");
    const previewDir = resolve(mindDir, "home", ".preview");
    mkdirSync(previewDir, { recursive: true });
    process.env.VOLUTE_CHROMIUM = writeStubBrowser(mindDir, {
      at: resolve(previewDir, "index.png"),
      target: decoy,
    });

    try {
      const result = await renderPreview({
        mindDir,
        mindName: "testmind",
        ownership: NO_ISOLATION,
        file: "index.html",
      });
      assert.ok("error" in result);
      assert.match(result.error, /Could not prepare the preview/);
      assert.equal(readFileSync(decoy, "utf-8"), "untouched");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("does not chown a file the render did not write", async () => {
    // The refused-copy path. Something is sitting at the image's name, so "does it
    // exist" answers yes — and it is the mind's, not ours. Handing it over is how a
    // hardlink to a file only the daemon can read becomes the mind's, which `-h`
    // does nothing about. Only the directory may be given away here.
    const outside = mkdtempSync(resolve(tmpdir(), "preview-outside-"));
    const decoy = resolve(outside, "decoy.txt");
    writeFileSync(decoy, "untouched");
    writeFileSync(resolve(pagesRoot, "index.html"), "<!doctype html><h1>hi</h1>");
    const previewDir = resolve(mindDir, "home", ".preview");
    mkdirSync(previewDir, { recursive: true });
    process.env.VOLUTE_CHROMIUM = writeStubBrowser(mindDir, {
      at: resolve(previewDir, "index.png"),
      target: decoy,
    });
    const { calls, exec } = recordingExec();

    try {
      const result = await renderPreview({
        mindDir,
        mindName: "testmind",
        ownership: isolationOn,
        file: "index.html",
        exec,
      });
      assert.ok("error" in result);
      assert.equal(calls.length, 1);
      assert.deepEqual(
        calls[0].slice(3),
        [realpathSync(previewDir)],
        "the planted file must not be in the chown argv",
      );
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("gives the mind the .preview dir even when the render fails", async () => {
    writeFileSync(resolve(pagesRoot, "index.html"), "<!doctype html><h1>hi</h1>");
    const { calls, exec } = recordingExec();

    const result = await renderPreview({
      mindDir,
      mindName: "testmind",
      ownership: isolationOn,
      file: "index.html",
      exec,
    });

    assert.ok("error" in result);
    assert.equal(calls.length, 1, "the dir the failed render created must still be handed over");
    assert.deepEqual(calls[0].slice(3), [realpathSync(resolve(mindDir, "home", ".preview"))]);
  });
});

/**
 * The scratch markdown html is written into the mind's own pages/ directory. Every
 * path that can throw between writing it and removing it has to end with it gone —
 * a leftover dotfile in pages/ is root-owned under isolation and undeletable.
 */
describe("renderPreview scratch-file cleanup", () => {
  it("removes the temp html when a step after writing it throws", async () => {
    writeFileSync(resolve(pagesRoot, "about.md"), "---\ntitle: About\n---\n# About me\n");
    // A regular file where the .preview directory has to go: mkdirSync throws, and
    // it throws after the temp html exists.
    writeFileSync(resolve(mindDir, "home", ".preview"), "not a directory");

    const result = await renderPreview({
      mindDir,
      mindName: "testmind",
      ownership: NO_ISOLATION,
      file: "about.md",
    });

    assert.ok("error" in result);
    assert.match(result.error, /Could not prepare the preview/);
    assert.deepEqual(
      readdirSync(pagesRoot).filter((f) => f.startsWith(".preview-src-")),
      [],
      "temp markdown html must not survive a failure before the render",
    );
  });
});
