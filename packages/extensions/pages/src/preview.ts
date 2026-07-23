import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, delimiter, join, resolve, sep } from "node:path";

import { parseFrontmatter, renderMarkdownPage, resolveStylesheet } from "./markdown.js";

/**
 * Render a draft page to an image so a mind can see how it looks in a browser —
 * the see-it half of the build → look → revise loop that a page in HTML earns and
 * a plain note does not. Runs daemon-side (the extension command path is proxied
 * to the daemon), so chromium runs as the daemon; the PNG lands under the mind's
 * home directory and the mind opens it with its own read tool.
 *
 * File ownership under isolation: the PNG (and any transient markdown html) are
 * written by the daemon as root, but the mind reads the PNG as its own user. Root
 * writes files 0644 and dirs 0755 by default (umask 022), so the .preview dir is
 * traversable and the PNG world-readable — the mind can read it with no chown.
 * Nothing here is mind-writable, so no ownership handoff is needed.
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
  file: string;
}): Promise<{ pngPath: string; rel: string } | { error: string }> {
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

  // The URL chromium screenshots. HTML is loaded straight from disk so its own
  // CSS and relative assets resolve. Markdown is first rendered through the same
  // renderer the serve route uses, written beside the page so a relative
  // stylesheet href still resolves, and cleaned up after.
  let tempHtml: string | null = null;
  let url: string;
  if (isHtml) {
    url = `file://${target}`;
  } else {
    const raw = readFileSync(target, "utf-8");
    const fm = parseFrontmatter(raw);
    const stylesheet = resolveStylesheet(target, pagesRoot, fm.style);
    const html = await renderMarkdownPage(fm.body, {
      title: fm.title,
      stylesheetUrl: stylesheet ?? undefined,
    });
    tempHtml = resolve(pagesRoot, `.preview-src-${token}.html`);
    writeFileSync(tempHtml, html, "utf-8");
    url = `file://${tempHtml}`;
  }

  const previewDir = resolve(opts.mindDir, "home", ".preview");
  mkdirSync(previewDir, { recursive: true });
  const pngName = `${opts.file.replace(/[/\\]/g, "__").replace(/\.(html|md)$/, "")}.png`;
  const pngPath = resolve(previewDir, pngName);
  const userDataDir = resolve("/tmp", `chromium-${token}`);

  try {
    await run(
      browser,
      [
        "--headless=new",
        "--no-sandbox",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--hide-scrollbars",
        "--force-color-profile=srgb",
        `--user-data-dir=${userDataDir}`,
        // Fixed viewport: the chromium CLI has no reliable full-page --screenshot
        // flag, so we capture a generous window rather than risk a fragile
        // scripted full-height capture. Tall pages are cut off below 1600px.
        "--window-size=1280,1600",
        `--screenshot=${pngPath}`,
        url,
      ],
      30_000,
    );
  } catch (err) {
    return {
      error: `Could not render the page: ${(err as Error).message}. (Is a browser installed? Set VOLUTE_CHROMIUM.)`,
    };
  } finally {
    if (tempHtml) rmSync(tempHtml, { force: true });
    rmSync(userDataDir, { recursive: true, force: true });
  }

  if (!existsSync(pngPath)) {
    return { error: "The browser ran but produced no image." };
  }
  return { pngPath, rel: `home/.preview/${basename(pngPath)}` };
}
