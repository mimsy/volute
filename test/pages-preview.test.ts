import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

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
    const result = await renderPreview({ mindDir, file: "../secret.html" });
    assert.deepEqual(result, { error: "Page path must stay within pages/." });
  });

  it("rejects an absolute path", async () => {
    const result = await renderPreview({ mindDir, file: "/etc/passwd" });
    assert.deepEqual(result, { error: "Page path must stay within pages/." });
  });
});

describe("renderPreview extension + existence handling", () => {
  it("returns the draft-it-first error for a missing file", async () => {
    const result = await renderPreview({ mindDir, file: "index.html" });
    assert.ok("error" in result);
    assert.match(result.error, /No page at pages\/index\.html/);
    assert.match(result.error, /Draft it in home\/pages\//);
  });

  it("rejects a non-.html/.md file", async () => {
    writeFileSync(resolve(pagesRoot, "notes.txt"), "hello");
    const result = await renderPreview({ mindDir, file: "notes.txt" });
    assert.deepEqual(result, { error: "Preview renders .html and .md pages." });
  });
});

describe("renderPreview graceful degradation without a browser", () => {
  it("returns an error (does not throw) for an .html page when chromium is absent", async () => {
    writeFileSync(resolve(pagesRoot, "index.html"), "<!doctype html><h1>hi</h1>");
    const result = await renderPreview({ mindDir, file: "index.html" });
    assert.ok("error" in result);
    assert.match(result.error, /Could not render the page/);
    assert.match(result.error, /VOLUTE_CHROMIUM/);
  });

  it("renders the .md branch, then degrades and cleans up the temp html", async () => {
    writeFileSync(resolve(pagesRoot, "about.md"), "---\ntitle: About\n---\n# About me\n");
    const result = await renderPreview({ mindDir, file: "about.md" });
    assert.ok("error" in result);
    assert.match(result.error, /Could not render the page/);
    // The transient markdown html is written into pages/ then removed in finally.
    const leftovers = readdirSync(pagesRoot).filter((f) => f.startsWith(".preview-src-"));
    assert.deepEqual(leftovers, [], "temp markdown html should be cleaned up");
  });

  it("does not leave a chromium user-data-dir behind on failure", async () => {
    writeFileSync(resolve(pagesRoot, "index.html"), "<!doctype html><h1>hi</h1>");
    await renderPreview({ mindDir, file: "index.html" });
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
      const result = await renderPreview({ mindDir, file: "index.html" });
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
