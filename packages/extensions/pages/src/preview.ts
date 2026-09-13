import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  accessSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, delimiter, join, relative, resolve, sep } from "node:path";

import { parseFrontmatter, renderMarkdownPage, resolveStylesheet } from "./markdown.js";
import {
  type ChownExec,
  chownToMind,
  type MindOwnership,
  MultiplyLinkedPageError,
  resolveHomeScratchDir,
  resolvePagesDir,
  resolvePagesRead,
} from "./ownership.js";
import { type PreviewServer, previewUrl, startPreviewServer } from "./preview-server.js";

/**
 * Render a draft page to an image so a mind can see how it looks in a browser —
 * the see-it half of the build → look → revise loop that a page in HTML earns and
 * a plain note does not. Runs daemon-side (the extension command path is proxied
 * to the daemon), so chromium runs as the daemon; the PNG lands under the mind's
 * home directory and the mind opens it with its own read tool.
 *
 * **Ownership.** Readable is not the same as the mind's. This used to reason that
 * root's default 0644/0755 made the PNG world-readable and therefore left nothing
 * to hand over — true about reading, and irrelevant. `home/` is the mind's own
 * space, and a preview it cannot delete is litter it is stuck with: unlinking a
 * file needs write permission on the *directory*, so a root-owned `.preview/`
 * accumulates undeletable PNGs render after render. Both the directory and the PNG
 * go back to the mind, on every render — including one that failed, which is
 * exactly the run that creates `.preview` and leaves nothing in it.
 *
 * **Containment.** The daemon reads `home/pages/<file>` as the daemon and hands the
 * result to root chromium, and the mind owns every component of that path. Both the
 * page and the `.preview` directory are resolved through their symlinks and proven
 * to be where they claim to be before anything is opened or written. See
 * `resolvePagesRead` and `resolveHomeScratchDir`.
 *
 * **The page's own content** is contained too, which checking the target is not
 * enough to do: a page can pull another local file into its rendering with no
 * script and no `file:` URL anywhere in its markup, and that file lands in the
 * screenshot. So the render no longer happens from a file origin at all. For the
 * length of one render the mind's pages directory is served over loopback, and
 * every load the page performs — the page, its stylesheet, an iframe, an image
 * whose name is a link — is proven to land inside that directory first. See
 * `preview-server.ts` (#1080).
 */

/**
 * macOS install locations for the Chrome-family browsers, in preference order.
 * Chrome, Chromium, Brave, and Edge all accept the exact --headless=new /
 * --screenshot / --user-data-dir flags we use, so one code path covers them all.
 */
const MAC_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
];

/** PATH command names for the same browser family on Linux/other, in preference order. */
const PATH_CANDIDATES = [
  "google-chrome",
  "google-chrome-stable",
  "chromium",
  "chromium-browser",
  "brave-browser",
  "microsoft-edge",
];

/** Default predicate: is `p` an existing, executable file (like `command -v` requires). */
function isExecutable(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the browser binary to drive. Returns the first available Chrome-family
 * browser, or null if none is found. Inputs are injectable so this is unit-testable
 * without depending on what happens to be installed on the test host.
 *
 * Order: explicit VOLUTE_CHROMIUM override → macOS app bundles → PATH lookup.
 */
export function resolveBrowser(opts?: {
  override?: string;
  platform?: NodeJS.Platform;
  pathEnv?: string;
  macCandidates?: string[];
  pathCandidates?: string[];
  exists?: (p: string) => boolean;
}): string | null {
  const override = opts?.override ?? process.env.VOLUTE_CHROMIUM;
  if (override) return override;

  const exists = opts?.exists ?? isExecutable;
  const platform = opts?.platform ?? process.platform;

  if (platform === "darwin") {
    for (const candidate of opts?.macCandidates ?? MAC_CANDIDATES) {
      if (exists(candidate)) return candidate;
    }
    return null;
  }

  // Linux/other: walk PATH dirs looking for an executable, `command -v` style.
  const dirs = (opts?.pathEnv ?? process.env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const name of opts?.pathCandidates ?? PATH_CANDIDATES) {
    for (const dir of dirs) {
      const full = join(dir, name);
      if (exists(full)) return full;
    }
  }
  return null;
}

/**
 * Per-invocation counter for temp-path uniqueness. process.pid is the daemon's
 * pid — constant across every preview — so two concurrent renders (two minds, or
 * one mind twice) would collide on the chromium user-data-dir singleton lock and
 * race on the temp markdown file. A fresh token per call keeps each render's
 * scratch paths distinct.
 */
let previewSeq = 0;

function run(cmd: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, env: { ...process.env, HOME: "/tmp" } }, (err) => {
      if (err) reject(err);
      else resolvePromise();
    });
  });
}

export async function renderPreview(opts: {
  mindDir: string;
  mindName: string;
  ownership: MindOwnership;
  file: string;
  exec?: ChownExec;
}): Promise<
  | { pngPath: string; rel: string; ownershipWarning: string | null }
  | { error: string; ownershipWarning?: string | null }
> {
  const pagesRoot = resolve(opts.mindDir, "home", "pages");
  const target = resolve(pagesRoot, opts.file);
  if (target !== pagesRoot && !target.startsWith(pagesRoot + sep)) {
    return { error: "Page path must stay within pages/." };
  }
  if (!existsSync(target)) {
    return {
      error: `No page at pages/${opts.file}. Draft it in home/pages/ first, then preview it.`,
    };
  }

  const isHtml = opts.file.endsWith(".html");
  const isMd = opts.file.endsWith(".md");
  if (!isHtml && !isMd) {
    return { error: "Preview renders .html and .md pages." };
  }

  // The check above is the friendly one: it catches a typo'd `../` and says so in
  // the mind's own terms. It is not containment — `resolve()` never touches the
  // filesystem, so it cannot tell a page from a symlink pointing out of `home/pages`
  // at something only the daemon can read. This can, because it resolves the real
  // path, the final hop included. Refusals are deliberately worded the same as a
  // plain escape and log the detail host-side: telling the mind where its link
  // landed would answer the question the link was asked to answer. A hard link is
  // the exception and is named outright — see the catch below.
  let realTarget: string;
  let realPagesRoot: string;
  try {
    realTarget = resolvePagesRead(opts.mindDir, target);
    realPagesRoot = resolvePagesDir(opts.mindDir);
  } catch (err) {
    console.warn(`[pages] refusing to preview ${target}: ${(err as Error).message}`);
    // A hard link is the one refusal that can be explained without giving
    // anything away: it reports what the mind did, not what it pointed at. And
    // "must stay within pages/" would be a lie about a file that is within
    // pages/ — the author would go looking for an escape that isn't there.
    if (err instanceof MultiplyLinkedPageError) {
      return {
        error:
          "That page has more than one name on disk. A preview renders the file itself, " +
          "so it has to be a file of its own — write the content into pages/ instead of " +
          "linking to it.",
      };
    }
    return { error: "Page path must stay within pages/." };
  }

  const browser = resolveBrowser();
  if (!browser) {
    return {
      error:
        "No Chrome-family browser found. Install Chrome or Chromium, or set VOLUTE_CHROMIUM to a browser binary.",
    };
  }

  // Unique per invocation so concurrent previews never share a chromium
  // user-data-dir or temp-file name (process.pid alone is the constant daemon pid).
  const token = `${process.pid}-${previewSeq++}-${randomUUID()}`;
  // A *separate* id for the origin's URL prefix, and the separation is the point.
  // These scratch directories live in /tmp, which is world-listable and mode 1777,
  // so anything that named them after the URL prefix would publish that prefix to
  // every process on the host with an `ls`. The prefix is not a secret either way
  // — it is in the browser's argv — but it should not be lying around in a second
  // place that is easier to read. See `preview-server.ts`.
  const originToken = randomUUID();
  const userDataDir = resolve("/tmp", `chromium-${token}`);
  const pngName = `${opts.file.replace(/[/\\]/g, "__").replace(/\.(html|md)$/, "")}.png`;

  // Chromium screenshots into a private directory of ours, not straight into the
  // mind's `.preview`. `.preview` belongs to the mind, so it can create entries
  // there; a render is seconds long and the final filename is predictable, which
  // makes "unlink the planted symlink, then let root open the path" a window the
  // mind can stand in. Root writes where nothing else can reach, and the finished
  // image moves across with an exclusive create.
  const stageDir = resolve("/tmp", `volute-preview-${token}`);
  const stagedPng = resolve(stageDir, "out.png");

  // Everything the daemon creates lives inside this block, so a throw anywhere in
  // it still reaches the `finally` that removes the scratch files. The previous
  // shape wrote the temp html *before* the try and leaked it whenever any later
  // step threw.
  let tempHtml: string | null = null;
  let server: PreviewServer | null = null;
  let realPreviewDir: string | null = null;
  let pngPath: string | null = null;
  let wrotePng = false;
  let failure: string | null = null;
  try {
    // The URL chromium screenshots — a loopback origin rather than the file the
    // page lives in, so the server is the boundary for every load the page makes.
    // HTML is served as it sits, so its own CSS and relative assets resolve.
    // Markdown is first rendered through the same renderer the serve route uses
    // and written at the root of the pages tree — which is what `resolveStylesheet`
    // returns a path relative to, so the href in the rendered page resolves — then
    // cleaned up after.
    server = await startPreviewServer(realPagesRoot, originToken);
    let url: string;
    if (isHtml) {
      url = previewUrl(server, relative(realPagesRoot, realTarget));
    } else {
      const raw = readFileSync(realTarget, "utf-8");
      const fm = parseFrontmatter(raw);
      const stylesheet = resolveStylesheet(realTarget, realPagesRoot, fm.style);
      const html = await renderMarkdownPage(fm.body, {
        title: fm.title,
        stylesheetUrl: stylesheet ?? undefined,
      });
      const scratch = resolve(realPagesRoot, `.preview-src-${token}.html`);
      // `wx` — create, never open something already there. The name carries a uuid
      // so nothing should be, and if something is, refusing beats writing through it.
      // Recorded for cleanup only once the create succeeded: a refusal means the
      // file is somebody else's, and the `finally` must not delete it.
      writeFileSync(scratch, html, { encoding: "utf-8", flag: "wx" });
      tempHtml = scratch;
      url = previewUrl(server, relative(realPagesRoot, scratch));
    }

    mkdirSync(resolve(opts.mindDir, "home", ".preview"), { recursive: true });
    // `home/` is the mind's, so `.preview` may be a link it put there; mkdir
    // follows one without complaint and `resolve()` cannot see it.
    realPreviewDir = resolveHomeScratchDir(opts.mindDir, ".preview");
    pngPath = resolve(realPreviewDir, pngName);
    // A failed render must not leave the previous image behind to be read as this
    // one, so the old file goes before the browser starts either way. Unlinking a
    // symlink removes the link, never what it points at.
    rmSync(pngPath, { force: true });
    mkdirSync(stageDir, { mode: 0o700 });

    try {
      await run(
        browser,
        [
          "--headless=new",
          "--no-sandbox",
          // The render fetches over loopback now, so a proxy configured on the
          // host becomes something between the browser and the page. Chrome
          // bypasses localhost by default, but a host that has overridden that
          // would get blank previews and no clue why.
          "--no-proxy-server",
          "--disable-gpu",
          "--disable-dev-shm-usage",
          "--hide-scrollbars",
          "--force-color-profile=srgb",
          `--user-data-dir=${userDataDir}`,
          // Fixed viewport: the chromium CLI has no reliable full-page --screenshot
          // flag, so we capture a generous window rather than risk a fragile
          // scripted full-height capture. Tall pages are cut off below 1600px.
          "--window-size=1280,1600",
          `--screenshot=${stagedPng}`,
          url,
        ],
        30_000,
      );
    } catch (err) {
      failure = `Could not render the page: ${(err as Error).message}. (Is a browser installed? Set VOLUTE_CHROMIUM.)`;
    }

    if (!failure) {
      if (!existsSync(stagedPng)) {
        failure = "The browser ran but produced no image.";
      } else {
        // Re-proven, not assumed: the first check was before a render seconds long,
        // and `.preview` is the mind's to swap. Narrowing the window to these two
        // lines is the same residual `resolvePagesWrite` documents, not a new one.
        pngPath = resolve(resolveHomeScratchDir(opts.mindDir, ".preview"), pngName);
        // Exclusive: whatever the mind may have put at this name during the render
        // is not written through, it is refused.
        copyFileSync(stagedPng, pngPath, constants.COPYFILE_EXCL);
        wrotePng = true;
      }
    }
  } catch (err) {
    // Deliberately generic, like the containment refusal above. These messages
    // carry resolved daemon-side paths, and the mind is who reads them.
    console.warn(`[pages] could not prepare a preview of ${opts.file}: ${(err as Error).message}`);
    failure = "Could not prepare the preview. The daemon log has the reason; ask your host.";
  } finally {
    // Before the scratch files, and on every path out of the try — a listener the
    // render left behind would go on serving this mind's drafts to anything on the
    // host for as long as the daemon lives.
    await server?.close();
    if (tempHtml) rmSync(tempHtml, { force: true });
    rmSync(stageDir, { recursive: true, force: true });
    rmSync(userDataDir, { recursive: true, force: true });
  }

  // Before the error return, not after it. A render that failed is the run that
  // creates `.preview` and puts nothing in it, and a directory the mind cannot
  // write is one it can never clear. Re-chowning the directory every time is also
  // what heals an install that accumulated root-owned previews before this fix.
  const owned: string[] = [];
  if (realPreviewDir) owned.push(realPreviewDir);
  // Only a file this render actually created. "It exists" is not the same question:
  // a refused copy means something the mind put there exists at that name, and
  // chowning it would hand over whatever it is — `-h` stops a symlink, not a
  // hardlink to an inode the daemon can reach and the mind cannot.
  if (wrotePng && pngPath) owned.push(pngPath);
  const ownershipWarning = await chownToMind(opts.ownership, opts.mindName, owned, opts.exec);

  // The warning rides the failure too. A failed render is the one that creates
  // `.preview` and leaves it empty, so it is exactly when a mind most needs to hear
  // that the directory may not be its own.
  if (failure) return { error: failure, ownershipWarning };
  if (!pngPath) return { error: "The browser ran but produced no image.", ownershipWarning };
  return { pngPath, rel: `home/.preview/${basename(pngPath)}`, ownershipWarning };
}
