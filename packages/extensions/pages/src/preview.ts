import { spawn } from "node:child_process";
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

  return findOnPath(opts?.pathCandidates ?? PATH_CANDIDATES, opts?.pathEnv, exists);
}

/** The first of `names` executable somewhere on PATH, `command -v` style, in `names` order. */
function findOnPath(
  names: string[],
  pathEnv: string | undefined,
  exists: (p: string) => boolean,
): string | null {
  const dirs = (pathEnv ?? process.env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const name of names) {
    for (const dir of dirs) {
      const full = join(dir, name);
      if (exists(full)) return full;
    }
  }
  return null;
}

/**
 * The install command per distribution, by `/etc/os-release` `ID`, for the ones
 * whose stock repositories carry a chromium preview can drive under that name.
 * Left out on purpose, because the command would not work as handed over: Ubuntu
 * (its chromium is a snap, with its own private /tmp), and RHEL, CentOS and Amazon
 * Linux (chromium needs EPEL first). They get prose instead.
 */
const DISTRO_INSTALLS: Record<string, string> = {
  debian: "apt-get update && apt-get install -y chromium",
  raspbian: "apt-get update && apt-get install -y chromium",
  fedora: "dnf install -y chromium",
  arch: "pacman -S --noconfirm chromium",
  alpine: "apk add chromium",
  "opensuse-leap": "zypper install -y chromium",
  "opensuse-tumbleweed": "zypper install -y chromium",
};

export type BrowserInstall = { command: string; as: string };

function readOsRelease(): string | null {
  try {
    return readFileSync("/etc/os-release", "utf-8");
  } catch {
    return null;
  }
}

/**
 * What a host would run to give preview a browser, and as whom, or null when we
 * can't name a command that would work as given. Injectable like
 * {@link resolveBrowser}.
 */
export function browserInstallCommand(opts?: {
  platform?: NodeJS.Platform;
  osRelease?: string | null;
}): BrowserInstall | null {
  const platform = opts?.platform ?? process.platform;
  if (platform === "darwin") {
    return {
      command: "brew install --cask google-chrome",
      as: "as your own user, not with sudo (Homebrew refuses to run as root)",
    };
  }
  if (platform !== "linux") return null;
  const release = opts?.osRelease === undefined ? readOsRelease() : opts.osRelease;
  const id = release?.match(/^ID="?([^"\n]*)"?$/m)?.[1];
  const command = id ? DISTRO_INSTALLS[id] : undefined;
  return command ? { command, as: "as root" } : null;
}

/** The alert kind for a host with no browser; the daemon namespaces it with the extension id. */
export const NO_BROWSER_ALERT_KIND = "preview_no_browser";

/**
 * What the mind is told when there is no browser. The old text told it to install
 * Chrome or set VOLUTE_CHROMIUM — neither of which it can do: it has no root, and
 * VOLUTE_CHROMIUM is the daemon's environment, not its own. So the failure reached
 * the one party who couldn't act on it and never reached the one who could, and
 * minds built canvas pages blind for a day before anyone with root heard (bardo,
 * Nov 2026). This says what is true from the mind's seat instead — including
 * whether the host was actually alerted, which only a caller that passed
 * `alertHost` can claim.
 */
export function noBrowserMindError(hostAlerted: boolean): string {
  return (
    "Preview can't run here: there is no browser on this host to render with, and " +
    "installing one needs the host. " +
    (hostAlerted
      ? "An alert about it has gone to your host.\n"
      : "Tell your host: preview needs Chrome or Chromium installed on the host.\n") +
    "Until then nothing here can show you your page — and tests passing over its logic " +
    "don't mean it draws. If how it looks matters, ask someone who can see it (your host, " +
    "or another mind) to open the published page and tell you what's there."
  );
}

/** What the host is told, through the spirit and the dashboard. */
export function noBrowserAlertText(mindName: string, install: BrowserInstall | null): string {
  const fix = install
    ? `On the host, ${install.as}:\n\n    ${install.command}`
    : "Install Google Chrome or Chromium on the host. (On Ubuntu the chromium package is a " +
      "snap, which preview can't use — install Google Chrome's .deb instead.)";
  return (
    "Pages preview can't run: the daemon found no Chrome-family browser on this host, so " +
    `minds can't see the pages they draw. ${mindName} just tried, and was told the host ` +
    `has been alerted.\n\n${fix}\n\nNo restart is needed — the next preview finds it. A ` +
    "browser the daemon's PATH doesn't reach can be named with VOLUTE_CHROMIUM in the " +
    "daemon's environment.\n\nThis is sent once per daemon run."
  );
}

/**
 * Whether the host has already heard, this daemon run, that there is no browser.
 * The condition is the host's, not one mind's, so the first mind to hit it is the
 * one that raises it; every preview after that would be the same news.
 */
let hostToldNoBrowser = false;

/** Tests only: forget that the host was told, so each test can watch the first alert. */
export function _resetNoBrowserAlertForTest(): void {
  hostToldNoBrowser = false;
}

/**
 * Limits on one browser launch, by phase — the page server's first request is the
 * line between them (see `launchBrowser`).
 *
 * - `startup`, spawn to first request: the browser starting. Measured 0.75 s on a
 *   laptop, 1.9 s typical and 9.0 s slow on a CI runner under a parallel suite —
 *   nearly 5x for the same commit — and a Pi with an SD card and several minds
 *   will do worse. A slow start is a slow host, not a broken page, and waiting
 *   costs only a mind's patience, so this is generous.
 * - `postLoad`, first request to exit: load, the page's virtual-time budget (run
 *   fast-forward), and the shot. 0.65–1.2 s everywhere it was measured, fast and
 *   slow starts alike. Running over is the one real stall: virtual time stands
 *   still while the page holds a request open.
 *
 * A start slower than `slowStart` is mentioned to the mind, so it knows the
 * delay was the host's and not its page's.
 *
 * Mutable only so tests need not wait them out.
 */
export const RENDER_TIMEOUTS = { startup: 30_000, postLoad: 8_000, slowStart: 10_000 };

/**
 * Switches that stop the browser's own background traffic and first-run work. In
 * Chrome's words: disable "several subsystems which run network requests in the
 * background"; component updates; syncing to a Google Account; default apps; the
 * first-run flow; and metrics reporting (recorded, never sent).
 */
export const PRIVATE_BROWSER_FLAGS = [
  "--disable-background-networking",
  "--disable-component-update",
  "--disable-sync",
  "--disable-default-apps",
  "--no-first-run",
  "--metrics-recording-only",
];

/**
 * Per-invocation counter for temp-path uniqueness. process.pid is the daemon's
 * pid — constant across every preview — so two concurrent renders (two minds, or
 * one mind twice) would collide on the chromium user-data-dir singleton lock and
 * race on the temp markdown file. A fresh token per call keeps each render's
 * scratch paths distinct.
 */
let previewSeq = 0;

type LaunchOutcome = {
  /** Which limit stopped it, if one did. A launch stopped at a limit is never trusted for its image. */
  limit: "startup" | "postLoad" | null;
  /** Why it failed on its own: a spawn error or a non-zero exit. */
  error: string | null;
  stderr: string;
  timing: LaunchTiming;
};

/**
 * Run the browser once under the two phase limits, watching the page server for
 * the line between them. One timeout cannot do this: a slow start and a stalled
 * page want opposite patience.
 */
function launchBrowser(
  cmd: string,
  args: string[],
  kind: LaunchTiming["kind"],
  server: Pick<PreviewServer, "requestsSince">,
): Promise<LaunchOutcome> {
  return new Promise((done) => {
    const started = Date.now();
    let stderr = "";
    let limit: LaunchOutcome["limit"] = null;
    let error: string | null = null;
    const child = spawn(cmd, args, {
      env: { ...process.env, HOME: "/tmp" },
      stdio: ["ignore", "ignore", "pipe"],
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4000);
    });
    let killTimer: NodeJS.Timeout | null = null;
    const stop = (which: "startup" | "postLoad") => {
      limit = which;
      child.kill("SIGTERM");
      // A browser that ignores SIGTERM is not left running as root.
      killTimer = setTimeout(() => child.kill("SIGKILL"), 3_000);
    };
    const watch = setInterval(() => {
      if (limit) return;
      const now = Date.now();
      const { firstAt } = server.requestsSince(started);
      if (firstAt === null) {
        if (now - started >= RENDER_TIMEOUTS.startup) stop("startup");
      } else if (now - firstAt >= RENDER_TIMEOUTS.postLoad) {
        stop("postLoad");
      }
    }, 50);
    child.on("error", (err) => {
      error = err.message;
    });
    child.on("close", (code, signal) => {
      clearInterval(watch);
      if (killTimer) clearTimeout(killTimer);
      if (!limit && !error && code !== 0) {
        error = `the browser exited with ${code === null ? `signal ${signal}` : `code ${code}`}`;
      }
      const ended = Date.now();
      const seen = server.requestsSince(started);
      done({
        limit,
        error,
        stderr,
        timing: {
          kind,
          totalMs: ended - started,
          toFirstRequestMs: seen.firstAt === null ? null : seen.firstAt - started,
          afterFirstRequestMs: seen.firstAt === null ? null : ended - seen.firstAt,
          requests: seen.count,
        },
      });
    });
  });
}

/** Where one browser launch spent its time. `null` phases: the browser never asked for the page. */
export type LaunchTiming = {
  kind: "timers" | "at-load";
  totalMs: number;
  toFirstRequestMs: number | null;
  afterFirstRequestMs: number | null;
  requests: number;
};

export async function renderPreview(opts: {
  mindDir: string;
  mindName: string;
  ownership: MindOwnership;
  file: string;
  exec?: ChownExec;
  /** Tell the host something only it can fix — the extension context's `alertHost`. */
  alertHost?: (kind: string, text: string) => Promise<void>;
  /** Called after each browser launch with where its time went. Diagnostics only. */
  onLaunch?: (timing: LaunchTiming) => void;
}): Promise<
  | { pngPath: string; rel: string; ownershipWarning: string | null; note: string | null }
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
    if (opts.alertHost && !hostToldNoBrowser) {
      hostToldNoBrowser = true;
      // Not awaited: the alert starts a spirit turn, and the mind's command should
      // not wait on one. alertHost never throws; the catch is a backstop.
      opts
        .alertHost(
          NO_BROWSER_ALERT_KIND,
          noBrowserAlertText(opts.mindName, browserInstallCommand()),
        )
        .catch((err) =>
          console.warn(`[pages] could not alert the host: ${(err as Error).message}`),
        );
    }
    // Claimed only when this call could raise it: the caller passed alertHost,
    // which then either sent it now or already did, earlier this run.
    return { error: noBrowserMindError(!!opts.alertHost) };
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
  let note: string | null = null;
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

    const args = (userDataDir: string, extra: string[]) => [
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
      // A preview is a picture of one page, and on a system install the browser
      // taking it is root's. Without these, every render also fetched a variations
      // seed and component/extension updates from Google (seen in a net-log). Each
      // is a documented Chrome switch, standard for headless automation. A few
      // requests remain (a time check, a signed-in-accounts probe); no switch here
      // claims to stop those.
      ...PRIVATE_BROWSER_FLAGS,
      `--user-data-dir=${userDataDir}`,
      ...extra,
      // Fixed viewport: the chromium CLI has no reliable full-page --screenshot
      // flag, so we capture a generous window rather than risk a fragile
      // scripted full-height capture. Tall pages are cut off below 1600px.
      "--window-size=1280,1600",
      `--screenshot=${stagedPng}`,
      url,
    ];
    const renderFailed = (reason: string) =>
      `Could not render the page: ${reason}. (The browser runs on the host's side; if this keeps happening, tell your host.)`;
    // Without virtual time the shot is taken at the load event, a few dozen ms in,
    // and a page that draws after a timer — a splash, an awaited delay, a game that
    // starts on setTimeout — previews as an empty canvas. Virtual time runs the
    // page's first seconds of timers before the shot, at no wall-clock cost while
    // the page is idle. requestAnimationFrame is not driven by it: a loop that
    // waits on many frames or on elapsed frame time still shoots early.
    //
    // No retry. Of the two ways a launch overruns, neither is helped by one: a slow
    // start pays the same start again with a fresh profile, and a page holding a
    // request open stalls again. What CI showed as intermittent "hangs" was the
    // start-up tail crossing a fixed limit (see RENDER_TIMEOUTS).
    const pageServer = server;
    const launch = async (kind: LaunchTiming["kind"], extra: string[]) => {
      // No image from an earlier launch may pass for this one's.
      rmSync(stagedPng, { force: true });
      const outcome = await launchBrowser(
        browser,
        args(`${userDataDir}-${kind}`, extra),
        kind,
        pageServer,
      );
      opts.onLaunch?.(outcome.timing);
      const t = outcome.timing;
      if (outcome.limit || (t.toFirstRequestMs ?? 0) >= RENDER_TIMEOUTS.slowStart) {
        // For the host: a slow or stopped preview, with where its time went and the
        // browser's own last words.
        const asked =
          t.toFirstRequestMs === null
            ? "the page server got no request from it"
            : `its first request reached the page server after ${t.toFirstRequestMs}ms, ` +
              `then ${t.afterFirstRequestMs}ms to exit (${t.requests} request(s))`;
        console.warn(
          `[pages] ${kind} render of ${opts.file} ` +
            `${outcome.limit ? `stopped at the ${outcome.limit} limit` : "started slowly"} ` +
            `after ${t.totalMs}ms (${browser}); ${asked}. ` +
            `Browser stderr (tail):\n${outcome.stderr.slice(-2000)}`,
        );
      }
      // A launch stopped at a limit is never trusted for its image: it may be half
      // written.
      if (outcome.limit) rmSync(stagedPng, { force: true });
      return outcome;
    };

    const slowStart = (t: LaunchTiming) =>
      t.toFirstRequestMs !== null && t.toFirstRequestMs >= RENDER_TIMEOUTS.slowStart
        ? `The browser on this host took ${Math.round(t.toFirstRequestMs / 1000)}s to start, so ` +
          "this preview was slow — and the next may be too. That's the host, not your page."
        : null;
    const notStarted =
      `the browser didn't start in time (it never asked for the page within ` +
      `${RENDER_TIMEOUTS.startup / 1000}s). That is the host being slow or its browser ` +
      "being broken, not your page";

    const first = await launch("timers", ["--virtual-time-budget=5000"]);
    const notes: string[] = [];
    if (first.error) {
      failure = renderFailed(first.error);
    } else if (first.limit === "startup") {
      failure = renderFailed(notStarted);
    } else if (first.limit === "postLoad") {
      // The page loaded and its timers never ran out — virtual time stands still
      // while a request is open. Such a page got a shot at load before virtual time
      // existed, so it gets that rather than nothing, and is told so.
      const second = await launch("at-load", []);
      if (second.error) failure = renderFailed(second.error);
      else if (second.limit === "startup") failure = renderFailed(notStarted);
      else if (second.limit === "postLoad")
        failure = renderFailed("the page didn't finish loading in time");
      else {
        notes.push(
          "Your page loaded, but its timers never finished running — a request the page " +
            "leaves open is the known cause. So this was taken as the page finished " +
            "loading, before any timers ran; anything drawn after a delay isn't in it.",
        );
        const slow = slowStart(second.timing) ?? slowStart(first.timing);
        if (slow) notes.push(slow);
      }
    } else {
      const slow = slowStart(first.timing);
      if (slow) notes.push(slow);
    }
    note = notes.length > 0 ? notes.join("\n") : null;

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
    for (const suffix of ["timers", "at-load"]) {
      rmSync(`${userDataDir}-${suffix}`, { recursive: true, force: true });
    }
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
  return { pngPath, rel: `home/.preview/${basename(pngPath)}`, ownershipWarning, note };
}
