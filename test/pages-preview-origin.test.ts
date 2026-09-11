/**
 * A preview renders from loopback, not from `file://`.
 *
 * Chromium runs as the daemon, and a `file://` page reaches other local files
 * without any script: an iframe, an object, or an image whose name is a symlink.
 * Whatever they resolve to gets drawn into the screenshot the mind then opens.
 * Checking the file the daemon opened was never enough, because the page itself
 * does the reaching.
 *
 * So the render is given an http origin whose server proves every request lands
 * inside the mind's real pages directory. These tests drive that server directly,
 * and drive `renderPreview` with a stub "browser" that actually performs the
 * fetches a real one would, so the refusal is observed rather than assumed.
 */
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
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

import { resolveStylesheet } from "../packages/extensions/pages/src/markdown.js";
import type { MindOwnership } from "../packages/extensions/pages/src/ownership.js";
import { renderPreview } from "../packages/extensions/pages/src/preview.js";
import {
  type PreviewServer,
  previewUrl,
  startPreviewServer,
} from "../packages/extensions/pages/src/preview-server.js";
import { PAGES_CSP } from "../packages/extensions/pages/src/serving.js";

const SECRET = "host-only-credential-do-not-render";

/** Make `to` a second name for `from`, or report that this filesystem will not. */
function hardlink(from: string, to: string): boolean {
  try {
    linkSync(from, to);
    return true;
  } catch {
    return false;
  }
}

const NO_ISOLATION: MindOwnership = {
  isIsolationEnabled: () => false,
  getMindUser: (name) => `mind-${name}`,
};

/** True when nothing is listening — the shape "the server was closed" takes. */
async function isClosed(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/`);
    return false;
  } catch {
    return true;
  }
}

describe("the preview origin server contains every request to the pages tree", () => {
  let root: string;
  let outside: string;
  let server: PreviewServer;

  beforeEach(async () => {
    root = realpathSync(mkdtempSync(resolve(tmpdir(), "preview-origin-root-")));
    outside = realpathSync(mkdtempSync(resolve(tmpdir(), "preview-origin-out-")));
    writeFileSync(resolve(root, "index.html"), "<h1>draft</h1>");
    writeFileSync(resolve(root, "style.css"), "body{color:red}");
    mkdirSync(resolve(root, "notes"));
    writeFileSync(resolve(outside, "secret.html"), SECRET);
    server = await startPreviewServer(root, "tok-1234");
  });

  afterEach(async () => {
    await server.close();
    for (const d of [root, outside]) rmSync(d, { recursive: true, force: true });
  });

  const get = (path: string) => fetch(`http://127.0.0.1:${server.port}${path}`);

  it("serves a real page with its content type", async () => {
    const res = await get("/tok-1234/index.html");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    assert.match(await res.text(), /draft/);

    const css = await get("/tok-1234/style.css");
    assert.equal(css.status, 200);
    assert.match(css.headers.get("content-type") ?? "", /text\/css/);
  });

  it("404s a subresource that is a symlink out of the tree", async () => {
    // The vector itself: nothing in the page names a file: URL, it just points an
    // <img>/<iframe> at a name the mind made into a link.
    symlinkSync(resolve(outside, "secret.html"), resolve(root, "leak.html"));
    const res = await get("/tok-1234/leak.html");
    assert.equal(res.status, 404);
    assert.ok(!(await res.text()).includes(SECRET));
  });

  it("404s a path reached through a symlinked directory", async () => {
    symlinkSync(outside, resolve(root, "elsewhere"));
    const res = await get("/tok-1234/elsewhere/secret.html");
    assert.equal(res.status, 404);
    assert.ok(!(await res.text()).includes(SECRET));
  });

  it("404s a traversal, including one that decodes to an absolute path", async () => {
    for (const path of [
      "/tok-1234/../../etc/hosts",
      "/tok-1234/%2e%2e%2f%2e%2e%2fetc%2fhosts",
      // Decoded this is `/etc/hosts`, which `resolve(root, …)` would otherwise
      // return verbatim rather than joining under the root.
      "/tok-1234/%2Fetc%2Fhosts",
      "/tok-1234/%zz",
    ]) {
      const res = await get(path);
      assert.equal(res.status, 404, `expected 404 for ${path}`);
    }
  });

  it("serves nothing outside its token prefix", async () => {
    // Loopback is reachable by every process on the host, minds included. Drafts
    // are what a mind has not decided to publish yet.
    for (const path of ["/index.html", "/", "/other-token/index.html"]) {
      assert.equal((await get(path)).status, 404, `expected 404 for ${path}`);
    }
  });

  it("lists no directories", async () => {
    for (const path of ["/tok-1234/", "/tok-1234/notes", "/tok-1234/notes/"]) {
      assert.equal((await get(path)).status, 404, `expected 404 for ${path}`);
    }
  });

  it("404s a hardlinked page, unlike an internal symlink", async (t) => {
    // The pair below is the whole distinction. An internal symlink is provably a
    // second route to a file inside the tree. A hard link proves nothing about the
    // inode it names — on macOS a mind can link a file it cannot itself read — and
    // it looks like an ordinary regular file to every other check here.
    if (!hardlink(resolve(outside, "secret.html"), resolve(root, "evil.html"))) {
      return t.skip("this filesystem refuses hard links");
    }
    const res = await get("/tok-1234/evil.html");
    assert.equal(res.status, 404);
    assert.ok(!(await res.text()).includes(SECRET));
  });

  it("serves an internal symlink, which escalates nothing", async () => {
    // Deliberately unlike the published-page rule. This tree is one the mind can
    // already read in full; what is being contained is the daemon's reach.
    symlinkSync(resolve(root, "index.html"), resolve(root, "alias.html"));
    const res = await get("/tok-1234/alias.html");
    assert.equal(res.status, 200);
    assert.match(await res.text(), /draft/);
  });

  it("encodes a page name that would otherwise cut the URL short", async () => {
    writeFileSync(resolve(root, "q&a #1.html"), "<h1>qa</h1>");
    const url = previewUrl(server, "q&a #1.html");
    assert.ok(!url.includes("#"), `the fragment marker must be escaped: ${url}`);
    const res = await fetch(url);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /qa/);
  });

  it("serves a page under the same rules publishing will", async () => {
    // A preview that renders under looser rules than the published page is a
    // preview that lies. The sandbox is the load-bearing part: it puts the page
    // in an opaque origin, where a same-origin fetch of its own data file fails.
    const res = await get("/tok-1234/index.html");
    const csp = res.headers.get("content-security-policy") ?? "";
    assert.match(csp, /sandbox allow-scripts/);
    assert.ok(!csp.includes("allow-same-origin"), "an opaque origin is the point");
    assert.match(csp, /base-uri 'none'/);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(PAGES_CSP, csp, "the preview's rules are the published page's rules");
  });

  it("does not leak a file descriptor per abandoned response", async () => {
    // `pipe` leaves the read stream open when the other end goes away, and the
    // other end going away is the normal case here: a render that timed out is
    // killed, and closing the server drops its sockets mid-response. The symptom
    // is not a hang — the server still closes — it is one descriptor per aborted
    // response, held for the daemon's life.
    writeFileSync(resolve(root, "big.txt"), "x".repeat(16 * 1024 * 1024));
    const before = readdirSync("/dev/fd").length;

    for (let i = 0; i < 12; i++) {
      const ac = new AbortController();
      // Abort after the response head has arrived but long before the body is
      // drained, which is where a half-finished pipe gets stranded.
      const res = await fetch(`http://127.0.0.1:${server.port}/tok-1234/big.txt`, {
        signal: ac.signal,
      });
      void res.body?.cancel().catch(() => {});
      ac.abort();
    }
    await new Promise((r) => setTimeout(r, 250));

    const after = readdirSync("/dev/fd").length;
    assert.ok(
      after - before < 6,
      `12 abandoned responses should not hold descriptors open: ${before} -> ${after}`,
    );
  });

  it("404s rather than sending an empty 200 when the open fails after the stat", async (t) => {
    // A 200 written off the stat, before the file is actually opened, turns a
    // failed open into a successful empty page — which is a worse answer than
    // "not found", because it looks like the page rendered.
    if (process.getuid?.() === 0) return t.skip("root can open anything");
    const locked = resolve(root, "locked.html");
    writeFileSync(locked, "<h1>secret-ish</h1>");
    chmodSync(locked, 0o000);
    try {
      openSync(locked, "r");
      return t.skip("this filesystem does not enforce the mode");
    } catch {
      // Good: unopenable, and the stat above it still succeeds.
    }

    const res = await get("/tok-1234/locked.html");
    assert.equal(res.status, 404, "an unopenable file is not found, not an empty success");
    assert.equal(await res.text(), "Not found");
    chmodSync(locked, 0o644);
  });

  it("stops serving once closed", async () => {
    const port = server.port;
    await server.close();
    assert.ok(await isClosed(port), "the port must be free after close()");
    await server.close(); // idempotent
  });
});

/**
 * A browser that is not a browser, but does make the requests one would: it fetches
 * the URL it was handed, then fetches a sibling the page would have pulled in, and
 * writes what came back where the test can read it.
 */
function writeFetchingStub(
  dir: string,
  log: string,
  opts: { subresource?: string; screenshot?: boolean; exitCode?: number } = {},
): string {
  const script = `
    const fs = require("node:fs");
    const args = process.argv.slice(1);
    const url = args[args.length - 1];
    const out = (args.find((a) => a.startsWith("--screenshot=")) || "").slice(13);
    (async () => {
      const udd = (args.find((a) => a.startsWith("--user-data-dir=")) || "").slice(16);
      const lines = ["url " + url, "screenshot " + out, "userDataDir " + udd];
      const fetchOne = async (label, u) => {
        try {
          const res = await fetch(u);
          lines.push(label + " " + res.status + " " + (await res.text()).replace(/\\n/g, " "));
        } catch (err) {
          lines.push(label + " ERR " + err.message);
        }
      };
      await fetchOne("page", url);
      ${
        opts.subresource
          ? `await fetchOne("sub", new URL(${JSON.stringify(opts.subresource)}, url).href);`
          : ""
      }
      fs.writeFileSync(${JSON.stringify(log)}, lines.join("\\n"));
      ${opts.screenshot === false ? "" : 'if (out) fs.writeFileSync(out, "PNG");'}
      process.exit(${opts.exitCode ?? 0});
    })();
  `;
  const path = resolve(dir, `fetching-stub-${stubSeq++}.sh`);
  writeFileSync(
    path,
    // `--` before the args: without it node parses chromium's flags as its own.
    ["#!/bin/sh", `exec ${JSON.stringify(process.execPath)} -e ${shq(script)} -- "$@"`, ""].join(
      "\n",
    ),
  );
  chmodSync(path, 0o755);
  return path;
}

/** Single-quote for /bin/sh. */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

let stubSeq = 0;

describe("renderPreview drives the browser at the loopback origin", () => {
  let mindDir: string;
  let pagesRoot: string;
  let outside: string;
  let stubDir: string;
  let logPath: string;
  let prevChromium: string | undefined;

  beforeEach(() => {
    mindDir = mkdtempSync(resolve(tmpdir(), "preview-origin-mind-"));
    outside = realpathSync(mkdtempSync(resolve(tmpdir(), "preview-origin-host-")));
    stubDir = mkdtempSync(resolve(tmpdir(), "preview-origin-stub-"));
    pagesRoot = resolve(mindDir, "home", "pages");
    mkdirSync(pagesRoot, { recursive: true });
    logPath = resolve(stubDir, "log.txt");
    writeFileSync(resolve(outside, "secret.txt"), SECRET);
    prevChromium = process.env.VOLUTE_CHROMIUM;
  });

  afterEach(() => {
    if (prevChromium === undefined) delete process.env.VOLUTE_CHROMIUM;
    else process.env.VOLUTE_CHROMIUM = prevChromium;
    for (const d of [mindDir, outside, stubDir]) rmSync(d, { recursive: true, force: true });
  });

  /** `url <the url>`, `page <status> <body>`, `sub <status> <body>` from the stub. */
  function log(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const line of readFileSync(logPath, "utf-8").split("\n")) {
      const idx = line.indexOf(" ");
      out[line.slice(0, idx)] = line.slice(idx + 1);
    }
    return out;
  }

  const portOf = (url: string) => Number(new URL(url).port);

  it("renders an html page over http and 404s its symlinked subresource", async () => {
    writeFileSync(resolve(pagesRoot, "index.html"), '<h1>draft</h1><img src="leak.txt">');
    symlinkSync(resolve(outside, "secret.txt"), resolve(pagesRoot, "leak.txt"));
    process.env.VOLUTE_CHROMIUM = writeFetchingStub(stubDir, logPath, {
      subresource: "leak.txt",
    });

    const result = await renderPreview({
      mindDir,
      mindName: "mimsy",
      ownership: NO_ISOLATION,
      file: "index.html",
    });
    assert.ok("pngPath" in result, `expected a render, got ${JSON.stringify(result)}`);

    const seen = log();
    assert.match(seen.url, /^http:\/\/127\.0\.0\.1:\d+\//, "not a file:// origin");
    assert.ok(!seen.url.startsWith("file:"), "the file origin is what this fixes");
    assert.match(seen.page, /^200 .*draft/, "the page itself still renders");
    assert.match(seen.sub, /^404/, "the symlinked subresource is refused");
    for (const line of Object.values(seen)) assert.ok(!line.includes(SECRET));

    assert.ok(await isClosed(portOf(seen.url)), "the server is closed after a render");
  });

  it("renders markdown over http too, with its stylesheet reachable", async () => {
    writeFileSync(resolve(pagesRoot, "note.md"), "---\ntitle: Note\n---\n\n# hi\n");
    writeFileSync(resolve(pagesRoot, "style.css"), "body{color:blue}");
    process.env.VOLUTE_CHROMIUM = writeFetchingStub(stubDir, logPath, {
      subresource: "style.css",
    });

    const result = await renderPreview({
      mindDir,
      mindName: "mimsy",
      ownership: NO_ISOLATION,
      file: "note.md",
    });
    assert.ok("pngPath" in result, `expected a render, got ${JSON.stringify(result)}`);

    const seen = log();
    assert.match(seen.url, /^http:\/\/127\.0\.0\.1:\d+\//);
    assert.match(seen.page, /^200 /);
    assert.match(seen.sub, /^200 .*color:blue/, "a legitimate stylesheet still loads");
    assert.ok(await isClosed(portOf(seen.url)));
  });

  it("closes the server when the browser fails, and when it produces no image", async () => {
    writeFileSync(resolve(pagesRoot, "index.html"), "<h1>draft</h1>");

    for (const opts of [{ exitCode: 1 }, { screenshot: false }]) {
      process.env.VOLUTE_CHROMIUM = writeFetchingStub(stubDir, logPath, opts);
      const result = await renderPreview({
        mindDir,
        mindName: "mimsy",
        ownership: NO_ISOLATION,
        file: "index.html",
      });
      assert.ok("error" in result, `expected a failure for ${JSON.stringify(opts)}`);
      assert.ok(
        await isClosed(portOf(log().url)),
        `the server must close on the ${JSON.stringify(opts)} path too`,
      );
    }
  });

  it("keeps the origin prefix out of the scratch paths in /tmp", async () => {
    // The prefix is in the browser's argv and cannot leave it, so it is not a
    // secret. It should still not be sitting in a second, easier place: /tmp is
    // mode 1777 and world-listable, and naming the browser's scratch directories
    // after the prefix would hand it to any process that ran `ls`.
    writeFileSync(resolve(pagesRoot, "index.html"), "<h1>draft</h1>");
    process.env.VOLUTE_CHROMIUM = writeFetchingStub(stubDir, logPath);
    await renderPreview({
      mindDir,
      mindName: "mimsy",
      ownership: NO_ISOLATION,
      file: "index.html",
    });

    const seen = log();
    const prefix = new URL(seen.url).pathname.split("/")[1];
    assert.ok(prefix.length > 0, "there is a prefix");
    assert.ok(
      !seen.userDataDir.includes(prefix),
      `the user-data-dir must not carry the prefix: ${seen.userDataDir}`,
    );
    assert.ok(
      !seen.screenshot.includes(prefix),
      `the stage dir must not carry the prefix: ${seen.screenshot}`,
    );
  });

  it("leaves no scratch html behind in the mind's pages directory", async () => {
    writeFileSync(resolve(pagesRoot, "note.md"), "# hi\n");
    process.env.VOLUTE_CHROMIUM = writeFetchingStub(stubDir, logPath);
    await renderPreview({ mindDir, mindName: "mimsy", ownership: NO_ISOLATION, file: "note.md" });
    assert.deepEqual(
      readdirSync(pagesRoot).filter((f) => f.startsWith(".preview-src-")),
      [],
      "the rendered scratch is cleaned up",
    );
  });
});

describe("a hardlinked markdown page is refused before it is read", () => {
  // The markdown branch renders the `.md` itself with `readFileSync` and never
  // fetches it over the preview origin, so the server's refusal cannot see it.
  // The resolver is the only place that covers both reads.
  let mindDir: string;
  let pagesRoot: string;
  let outside: string;
  let stubDir: string;
  let prevChromium: string | undefined;

  beforeEach(() => {
    mindDir = mkdtempSync(resolve(tmpdir(), "preview-hl-mind-"));
    outside = realpathSync(mkdtempSync(resolve(tmpdir(), "preview-hl-host-")));
    stubDir = mkdtempSync(resolve(tmpdir(), "preview-hl-stub-"));
    pagesRoot = resolve(mindDir, "home", "pages");
    mkdirSync(pagesRoot, { recursive: true });
    writeFileSync(resolve(outside, "secret.md"), `# ${SECRET}\n`);
    prevChromium = process.env.VOLUTE_CHROMIUM;
  });

  afterEach(() => {
    if (prevChromium === undefined) delete process.env.VOLUTE_CHROMIUM;
    else process.env.VOLUTE_CHROMIUM = prevChromium;
    for (const d of [mindDir, outside, stubDir]) rmSync(d, { recursive: true, force: true });
  });

  it("refuses without launching a browser, and says why", async (t) => {
    if (!hardlink(resolve(outside, "secret.md"), resolve(pagesRoot, "note.md"))) {
      return t.skip("this filesystem refuses hard links");
    }
    const logPath = resolve(stubDir, "log.txt");
    process.env.VOLUTE_CHROMIUM = writeFetchingStub(stubDir, logPath);

    const result = await renderPreview({
      mindDir,
      mindName: "mimsy",
      ownership: NO_ISOLATION,
      file: "note.md",
    });

    assert.ok("error" in result, "a hardlinked page is not rendered");
    // Named outright. Saying "more than one name on disk" reports what the mind
    // did, not what it pointed at, so it gives nothing away — and "must stay
    // within pages/" would be false about a file that is within pages/.
    assert.match(result.error, /more than one name on disk/);
    assert.doesNotMatch(result.error, /must stay within/);
    assert.ok(!existsSync(logPath), "the browser is never launched");
  });

  it("refuses a hardlinked html page the same way", async (t) => {
    if (!hardlink(resolve(outside, "secret.md"), resolve(pagesRoot, "index.html"))) {
      return t.skip("this filesystem refuses hard links");
    }
    // Stubbed so that breaking the refusal fails fast instead of launching a real
    // browser and waiting out the 30s render timeout.
    process.env.VOLUTE_CHROMIUM = writeFetchingStub(stubDir, resolve(stubDir, "html-log.txt"));
    const result = await renderPreview({
      mindDir,
      mindName: "mimsy",
      ownership: NO_ISOLATION,
      file: "index.html",
    });
    assert.ok("error" in result);
    assert.match(result.error, /more than one name on disk/);
  });
});

describe("resolveStylesheet measures containment on real paths", () => {
  let root: string;
  let outside: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(resolve(tmpdir(), "preview-css-root-")));
    outside = realpathSync(mkdtempSync(resolve(tmpdir(), "preview-css-out-")));
    writeFileSync(resolve(outside, "theme.css"), SECRET);
  });

  afterEach(() => {
    for (const d of [root, outside]) rmSync(d, { recursive: true, force: true });
  });

  it("refuses a frontmatter stylesheet reached through a symlinked directory", () => {
    // `resolve()` never touches the filesystem, so the prefix check this replaces
    // could not tell `notes/` the directory from `notes/` the link.
    symlinkSync(outside, resolve(root, "notes"));
    writeFileSync(resolve(root, "page.md"), "# hi");
    assert.equal(resolveStylesheet(resolve(root, "page.md"), root, "notes/theme.css"), null);
  });

  it("refuses a frontmatter stylesheet that is itself a symlink out of the tree", () => {
    symlinkSync(resolve(outside, "theme.css"), resolve(root, "theme.css"));
    writeFileSync(resolve(root, "page.md"), "# hi");
    assert.equal(resolveStylesheet(resolve(root, "page.md"), root, "theme.css"), null);
  });

  it("still finds a real stylesheet, by frontmatter and by convention", () => {
    writeFileSync(resolve(root, "theme.css"), "body{}");
    writeFileSync(resolve(root, "style.css"), "body{}");
    writeFileSync(resolve(root, "page.md"), "# hi");
    assert.equal(resolveStylesheet(resolve(root, "page.md"), root, "theme.css"), "theme.css");
    assert.equal(resolveStylesheet(resolve(root, "page.md"), root), "style.css");
  });
});
