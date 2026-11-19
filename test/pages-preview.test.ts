import assert from "node:assert/strict";
import { execFile } from "node:child_process";
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

import type { ExtensionCommand } from "@volute/extensions";
import { createCommands } from "../packages/extensions/pages/src/commands.js";
import type { ChownExec, MindOwnership } from "../packages/extensions/pages/src/ownership.js";
import {
  _resetNoBrowserAlertForTest,
  browserInstallCommand,
  type LaunchTiming,
  NO_BROWSER_ALERT_KIND,
  noBrowserAlertText,
  noBrowserMindError,
  PRIVATE_BROWSER_FLAGS,
  RENDER_TIMEOUTS,
  renderPreview,
  resolveBrowser,
} from "../packages/extensions/pages/src/preview.js";

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
    // Addressed to the mind, who can neither install a browser nor set the
    // daemon's environment.
    assert.match(result.error, /tell your host/);
    assert.doesNotMatch(result.error, /Set VOLUTE_CHROMIUM/);
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

  /** Run `fn` with nothing resolvable as a browser, whatever the test host has. */
  async function withNoBrowser(fn: () => Promise<void>): Promise<void> {
    writeFileSync(resolve(pagesRoot, "index.html"), "<!doctype html><h1>hi</h1>");
    // Unset the override, pretend to be linux, and give the resolver an empty PATH.
    delete process.env.VOLUTE_CHROMIUM;
    const prevPath = process.env.PATH;
    const platformDesc = Object.getOwnPropertyDescriptor(process, "platform");
    process.env.PATH = "";
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    _resetNoBrowserAlertForTest();
    try {
      await fn();
    } finally {
      if (platformDesc) Object.defineProperty(process, "platform", platformDesc);
      if (prevPath === undefined) delete process.env.PATH;
      else process.env.PATH = prevPath;
    }
  }

  it("with no browser, tells the host once and the mind that it was told", async () => {
    await withNoBrowser(async () => {
      const alerts: { kind: string; text: string }[] = [];
      const alertHost = async (kind: string, text: string) => {
        alerts.push({ kind, text });
      };

      // The first through the command, which is what hands renderPreview the
      // context's alertHost — the wiring the daemon's path depends on.
      const ctx = {
        ...NO_ISOLATION,
        mindName: "pip",
        getMindDir: async () => mindDir,
        alertHost,
      } as unknown as Parameters<ExtensionCommand["handler"]>[1];
      const first = await createCommands().preview.handler({ args: {}, flags: {}, rest: [] }, ctx);
      assert.deepEqual(first, { error: noBrowserMindError(true) });
      // The old text told the mind to install Chrome or set VOLUTE_CHROMIUM — the
      // two things it cannot do.
      assert.match(noBrowserMindError(true), /alert about it has gone to your host/);
      assert.doesNotMatch(noBrowserMindError(true), /VOLUTE_CHROMIUM|Install Chrome/);

      assert.equal(alerts.length, 1, "the host is told on the first failure");
      assert.equal(alerts[0].kind, NO_BROWSER_ALERT_KIND);
      assert.match(alerts[0].text, /pip just tried/);

      // The condition is the host's, not one mind's: a second mind hitting it is
      // the same news, and every alert is a spirit turn. It was still told, though.
      const second = await renderPreview({
        mindDir,
        mindName: "mimsy",
        ownership: NO_ISOLATION,
        file: "index.html",
        alertHost,
      });
      assert.deepEqual(second, { error: noBrowserMindError(true) });
      assert.equal(alerts.length, 1, "once per daemon run, not once per call");
    });
  });

  it("does not claim the host was told when nothing could tell it", async () => {
    await withNoBrowser(async () => {
      const result = await renderPreview({
        mindDir,
        mindName: "pip",
        ownership: NO_ISOLATION,
        file: "index.html",
      });
      assert.deepEqual(result, { error: noBrowserMindError(false) });
      assert.doesNotMatch(noBrowserMindError(false), /has gone to your host/);
      assert.match(noBrowserMindError(false), /Tell your host/);
    });
  });
});

describe("browserInstallCommand", () => {
  const linux = (osRelease: string | null) =>
    browserInstallCommand({ platform: "linux", osRelease });

  it("names the command for a distribution whose chromium works as handed over", () => {
    assert.deepEqual(linux('PRETTY_NAME="Debian GNU/Linux 12"\nID=debian\n'), {
      command: "apt-get update && apt-get install -y chromium",
      as: "as root",
    });
    assert.equal(
      linux('ID="raspbian"\n')?.command,
      "apt-get update && apt-get install -y chromium",
    );
    assert.equal(linux("ID=fedora\n")?.command, "dnf install -y chromium");
  });

  it("names none where the obvious command would not work", () => {
    // Ubuntu's chromium is a snap; RHEL-family chromium needs EPEL first.
    assert.equal(linux("ID=ubuntu\nID_LIKE=debian\n"), null);
    assert.equal(linux('ID="rhel"\n'), null);
    assert.equal(linux('ID="amzn"\n'), null);
    assert.equal(linux(null), null);
  });

  it("uses Homebrew on macOS, as the user — Homebrew refuses root", () => {
    const got = browserInstallCommand({ platform: "darwin" });
    assert.equal(got?.command, "brew install --cask google-chrome");
    assert.match(got?.as ?? "", /not with sudo/);
  });

  it("puts the command in the host's alert, and degrades to prose without one", () => {
    assert.match(
      noBrowserAlertText("pip", { command: "apk add chromium", as: "as root" }),
      /On the host, as root:\n\n {4}apk add chromium\n/,
    );
    assert.match(noBrowserAlertText("pip", null), /Google Chrome's \.deb/);
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

/**
 * A browser that is not one, but has both phases a real one does: it waits
 * `startDelayMs` (startup), asks the preview server for the page, then either
 * writes its image or hangs. A hang first leaves a half-written image where the
 * shot goes, as a stopped browser might. Real Chrome exits 0 on SIGTERM
 * (`exits-0`); `dies` is the other shape. Every launch logs its argv.
 */
function writePhaseStub(
  dir: string,
  log: string,
  opts: {
    startDelayMs?: number;
    /** Time between the page arriving and the image: load, timers, the shot. */
    afterRequestMs?: number;
    neverRequests?: boolean;
    hang?: "with-timers" | "always";
    onTerm?: "exits-0" | "dies";
    /** The at-load launch exits cleanly without drawing anything. */
    atLoadDrawsNothing?: boolean;
  } = {},
): string {
  const script = `
    const fs = require("node:fs");
    const args = process.argv.slice(1);
    fs.appendFileSync(${JSON.stringify(log)}, args.join(" ") + "\\n");
    const url = args[args.length - 1];
    const out = (args.find((a) => a.startsWith("--screenshot=")) || "").slice(13);
    const timers = args.some((a) => a.startsWith("--virtual-time-budget="));
    const hangFor = ${JSON.stringify(opts.hang ?? null)};
    ${opts.onTerm === "dies" ? "" : 'process.on("SIGTERM", () => process.exit(0));'}
    const forever = () => setInterval(() => {}, 1000);
    setTimeout(async () => {
      if (${opts.neverRequests ? "true" : "false"}) return forever();
      await fetch(url).then((r) => r.text()).catch(() => {});
      if (hangFor === "always" || (hangFor === "with-timers" && timers)) {
        fs.writeFileSync(out, "HALF");
        return forever();
      }
      await new Promise((r) => setTimeout(r, ${opts.afterRequestMs ?? 0}));
      if (!(${opts.atLoadDrawsNothing ? "true" : "false"} && !timers)) fs.writeFileSync(out, "PNG");
      process.exit(0);
    }, ${opts.startDelayMs ?? 0});
  `;
  const path = resolve(dir, `phase-stub-${stubSeq++}.sh`);
  writeFileSync(
    path,
    // `--` before the args: without it node parses chromium's flags as its own.
    [
      "#!/bin/sh",
      `exec ${JSON.stringify(process.execPath)} -e '${script.replace(/'/g, `'\\''`)}' -- "$@"`,
      "",
    ].join("\n"),
  );
  chmodSync(path, 0o755);
  return path;
}

describe("renderPreview's two phases: a slow start, and a page that never settles", () => {
  let prev: typeof RENDER_TIMEOUTS;
  let warnings: string[];
  let warn: typeof console.warn;
  beforeEach(() => {
    prev = { ...RENDER_TIMEOUTS };
    Object.assign(RENDER_TIMEOUTS, { startup: 1500, postLoad: 800, slowStart: 400 });
    warnings = [];
    warn = console.warn;
    console.warn = (...a: unknown[]) => warnings.push(a.map(String).join(" "));
    writeFileSync(resolve(pagesRoot, "index.html"), "<!doctype html><h1>hi</h1>");
  });
  afterEach(() => {
    console.warn = warn;
    Object.assign(RENDER_TIMEOUTS, prev);
  });
  const log = () => resolve(mindDir, "argv.log");
  const launches = () => readFileSync(log(), "utf-8").trim().split("\n");
  const preview = () =>
    renderPreview({ mindDir, mindName: "testmind", ownership: NO_ISOLATION, file: "index.html" });

  it("asks for virtual time and the private flags, once, when all is well", async () => {
    process.env.VOLUTE_CHROMIUM = writePhaseStub(mindDir, log());
    const result = await preview();
    assert.ok(!("error" in result), "error" in result ? result.error : "");
    assert.equal(result.note, null);
    assert.equal(launches().length, 1);
    const argv = launches()[0].split(" ");
    assert.ok(argv.includes("--virtual-time-budget=5000"));
    // Root's browser does not phone out on every preview.
    for (const flag of PRIVATE_BROWSER_FLAGS) assert.ok(argv.includes(flag), `missing ${flag}`);
    assert.deepEqual(warnings, []);
  });

  it("waits out a slow start, keeps the timers, and tells the mind it was the host", async () => {
    // CI's 9 s start, scaled: the start plus the page's own time exceeds the
    // post-load limit, which must only count from the page's arrival.
    process.env.VOLUTE_CHROMIUM = writePhaseStub(mindDir, log(), {
      startDelayMs: 1000,
      afterRequestMs: 300,
    });
    const result = await preview();
    assert.ok(!("error" in result), "error" in result ? result.error : "");
    assert.equal(launches().length, 1, "no fallback for a slow start");
    assert.match(launches()[0], /--virtual-time-budget/);
    assert.match(result.note ?? "", /took \d+s to start/);
    assert.match(result.note ?? "", /not your page/);
    assert.doesNotMatch(result.note ?? "", /timers never finished/);
    assert.equal(readFileSync(result.pngPath, "utf-8"), "PNG");
    assert.ok(
      warnings.some((w) => /started slowly/.test(w)),
      "the host's log says so too",
    );
  });

  for (const onTerm of ["exits-0", "dies"] as const) {
    it(`falls back to a shot at load when the page's timers never run out (${onTerm})`, async () => {
      process.env.VOLUTE_CHROMIUM = writePhaseStub(mindDir, log(), {
        hang: "with-timers",
        onTerm,
      });
      const result = await preview();
      assert.ok(!("error" in result), "error" in result ? result.error : "");
      assert.match(result.note ?? "", /timers never finished/);
      const [first, second] = launches();
      assert.equal(launches().length, 2);
      assert.match(first, /--virtual-time-budget/);
      assert.doesNotMatch(second, /--virtual-time-budget/);
      // A fresh profile for the second launch: a stopped one may still hold its lock.
      const profile = (l: string) => l.match(/--user-data-dir=(\S+)/)?.[1];
      assert.notEqual(profile(first), profile(second));
      // The stopped launch's half-written image is not what the mind got.
      assert.equal(readFileSync(result.pngPath, "utf-8"), "PNG");
      const stopped = warnings.filter((w) => w.includes("stopped at the postLoad limit"));
      assert.equal(stopped.length, 1);
      assert.match(stopped[0], /first request reached the page server after \d+ms/);
    });
  }

  it("fails plainly when the browser never asks for the page — no shot at load", async () => {
    process.env.VOLUTE_CHROMIUM = writePhaseStub(mindDir, log(), { neverRequests: true });
    const result = await preview();
    assert.ok("error" in result);
    assert.match(result.error, /didn't start in time/);
    assert.match(result.error, /not your page/);
    // A fallback would need the same start, so none is tried.
    assert.equal(launches().length, 1);
    assert.ok(warnings.some((w) => /stopped at the startup limit.*got no request/s.test(w)));
  });

  it("never hands over an image from a launch that was stopped", async () => {
    // The first launch loads, hangs, and is stopped with a half-written image in
    // place; the at-load launch then exits cleanly having drawn nothing. The
    // leftover must not pass for a render.
    process.env.VOLUTE_CHROMIUM = writePhaseStub(mindDir, log(), {
      hang: "with-timers",
      atLoadDrawsNothing: true,
    });
    const result = await preview();
    assert.deepEqual("error" in result && result.error, "The browser ran but produced no image.");
    assert.equal(launches().length, 2);
  });

  it("fails plainly when the page never settles even without timers", async () => {
    process.env.VOLUTE_CHROMIUM = writePhaseStub(mindDir, log(), { hang: "always" });
    const result = await preview();
    assert.ok("error" in result);
    assert.match(result.error, /didn't finish loading in time/);
    assert.equal(launches().length, 2);
  });
});

/**
 * Resolved at import, before the outer beforeEach points VOLUTE_CHROMIUM at a
 * bogus binary. CI runners carry Chrome, so this runs there; a host without one
 * skips it rather than failing.
 */
const REAL_BROWSER = resolveBrowser();

describe("renderPreview with a real browser", { skip: !REAL_BROWSER && "no browser" }, () => {
  it("captures a canvas that first draws after a timer, not the blank before it", async (t) => {
    // The shape of a game whose first frame comes after a load delay. Taken at the
    // load event, as the shot was, this was a black rectangle — a mind's logic
    // tests could pass over a screen that never drew.
    writeFileSync(
      resolve(pagesRoot, "game.html"),
      `<!doctype html><body style="margin:0;background:#000">
<canvas id="c" width="400" height="300"></canvas>
<script type="module">
const ctx = document.getElementById("c").getContext("2d");
await new Promise((r) => setTimeout(r, 500));
requestAnimationFrame(() => { ctx.fillStyle = "#f00"; ctx.fillRect(0, 0, 400, 300); });
</script></body>`,
    );
    process.env.VOLUTE_CHROMIUM = REAL_BROWSER as string;
    // This only fails on some hosts' browsers, so a failure has to carry what
    // happened there: timing, whether the at-load fallback fired, the browser and
    // its version, and its own stderr (which renderPreview logs on a stall).
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (...a: unknown[]) => warnings.push(a.map(String).join(" "));
    const started = Date.now();
    const launches: LaunchTiming[] = [];
    let result: Awaited<ReturnType<typeof renderPreview>>;
    try {
      result = await renderPreview({
        mindDir,
        mindName: "testmind",
        ownership: NO_ISOLATION,
        file: "game.html",
        onLaunch: (l) => launches.push(l),
      });
    } finally {
      console.warn = warn;
    }
    const version = await new Promise<string>((r) =>
      execFile(REAL_BROWSER as string, ["--version"], (_e, out) => r(String(out).trim())),
    );
    const diagnosis = [
      `browser: ${REAL_BROWSER} (${version})`,
      `render took ${Date.now() - started}ms`,
      // Per launch: spawn → the page server's first request is browser startup;
      // first request → exit is load, virtual time and the shot.
      ...launches.map(
        (l, i) =>
          `launch ${i + 1} (${l.kind}): spawn→first request ${l.toFirstRequestMs ?? "never"}ms, ` +
          `first request→exit ${l.afterFirstRequestMs ?? "-"}ms, total ${l.totalMs}ms, ` +
          `${l.requests} request(s)`,
      ),
      `result: ${JSON.stringify(result)}`,
      ...warnings,
    ].join("\n");
    // Every run, pass or fail, stall or not: the slow tail is only readable as a
    // distribution, and a pass would otherwise drop its half of it.
    for (const line of diagnosis.split("\n")) t.diagnostic(line);
    console.log(`[pages-preview real-browser diagnostics]\n${diagnosis}`);
    assert.ok(!("error" in result), diagnosis);
    const { default: sharp } = await import("sharp");
    const { data, info } = await sharp(result.pngPath)
      .extract({ left: 100, top: 100, width: 1, height: 1 })
      .raw()
      .toBuffer({ resolveWithObject: true });
    assert.equal(info.channels >= 3, true);
    assert.deepEqual(
      [data[0], data[1], data[2]],
      [255, 0, 0],
      `the canvas drew before the shot\n${diagnosis}`,
    );
  });
});
