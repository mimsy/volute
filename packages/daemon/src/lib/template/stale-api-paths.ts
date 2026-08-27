import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { deliverEvent, recordNotice } from "../chat/system-events.js";
import { getSpiritName } from "../config/setup.js";
import { isSpiritName, mindDir, readRegistry } from "../mind/registry.js";
import log from "../util/logger.js";

const slog = log.child("stale-api-paths");

/**
 * Removed API prefixes. #900 collapsed the daemon API to a single `/api/v1`
 * prefix; anything still calling the bare `/api/minds/…` or `/api/extensions/…`
 * paths gets a 404 on every turn.
 *
 * Substring matching is safe in both directions: `/api/v1/minds/` does not
 * contain `/api/minds/`, so a current file never matches. `/api/extensions/` is
 * included as well as `/api/minds/` — the pre-#900 `startup-context.ts` fetched
 * the mind-docs list from it, and a mind whose startup context is silently empty
 * is just as cut off as one whose notices never arrive.
 */
const REMOVED_API_PREFIXES = ["/api/minds/", "/api/extensions/"] as const;

/**
 * Trees and files a mind runs that talk to the daemon over HTTP.
 *
 * Skills matter as much as hooks here: a skill is *copied* into the mind at
 * install time and tracked for updates independently, so a path fixed in the
 * shared pool doesn't reach an already-installed copy. `imagegen` shipped with
 * `/api/minds/…/imagegen/jobs` and has been dead for every mind since 0.58.0
 * for exactly that reason.
 */
const SCAN_SUBDIRS = ["home/.local/hooks", "home/.claude/skills"];
const DAEMON_CLIENT_REL = "src/lib/daemon-client.ts";

export type StaleApiPaths = {
  mind: string;
  /** Mind-directory-relative paths that still reference a removed prefix. */
  files: string[];
};

/**
 * Minds already told about this, this daemon run. The condition is static — it
 * does not resolve on its own between sweeps — so telling a mind about it once
 * per daemon start is the whole of the useful signal, and telling it hourly
 * would be noise inside its own context window. The `log.error` is deliberately
 * *not* rate-limited: a host tailing the journal should keep seeing it until it
 * is fixed, which is the same reasoning `warnStrandedEvents` documents.
 */
const notified = new Set<string>();

/** Test seam: forget which minds have been notified this run. */
export function resetStaleApiNotifications(): void {
  notified.clear();
}

/** Recursively list files under `dir`, returning paths relative to `base`. */
async function listFilesRelative(dir: string, base: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await listFilesRelative(full, base)));
    } else if (entry.isFile()) {
      out.push(full.slice(base.length + 1));
    }
  }
  return out;
}

/** True if the file at `path` mentions any removed API prefix. */
async function referencesRemovedPrefix(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    // Skip anything implausibly large for a hook — this runs over every mind hourly.
    if (!info.isFile() || info.size > 1_000_000) return false;
    const content = await readFile(path, "utf-8");
    return REMOVED_API_PREFIXES.some((prefix) => content.includes(prefix));
  } catch {
    return false;
  }
}

/**
 * Scan one mind's directory for files still calling the removed API prefixes.
 * Returns the mind-relative paths, sorted; empty means healthy.
 */
export async function findStaleApiPathsIn(dir: string): Promise<string[]> {
  const candidates = [DAEMON_CLIENT_REL];
  for (const sub of SCAN_SUBDIRS) {
    candidates.push(...(await listFilesRelative(resolve(dir, sub), dir)));
  }

  const stale: string[] = [];
  for (const rel of candidates) {
    if (await referencesRemovedPrefix(resolve(dir, rel))) stale.push(rel);
  }
  return stale.sort();
}

/**
 * Every registered mind (and the spirit) whose hooks, installed skills, or
 * daemon client still call a removed API path. `readRegistry()` covers base minds and the spirit and
 * excludes variants — a variant is a worktree of its parent and gets fixed with it.
 */
export async function findMindsWithStaleApiPaths(): Promise<StaleApiPaths[]> {
  const out: StaleApiPaths[] = [];
  for (const entry of await readRegistry()) {
    // The spirit's directory is not under the minds dir; the registry carries it.
    const dir = entry.dir ?? mindDir(entry.name);
    const files = await findStaleApiPathsIn(dir);
    if (files.length > 0) out.push({ mind: entry.name, files });
  }
  return out;
}

/**
 * How an unedited file gets repaired, which is not the same sentence for
 * everyone. `volute mind upgrade` 404s on the spirit — it checks
 * `existsSync(mindDir(name))` and the spirit lives under `voluteSystemDir()` —
 * so telling the spirit to run it would repeat the original sin of this bug:
 * advice that sounds actionable and isn't.
 */
function repairRoute(mind: string): string {
  return isSpiritName(mind)
    ? `restarting the daemon refreshes any of these files you have not edited yourself ` +
        `(\`syncSpiritTemplate\` runs on every start; \`volute mind upgrade\` does not apply to you)`
    : `\`volute mind upgrade\` now replaces any of these files you have not edited yourself`;
}

/** The body of the message a mind gets about its own stale files. */
export function staleApiPathsMessage(files: string[], mind: string): string {
  return (
    `Some of your Volute infrastructure files still call daemon API paths that were removed in ` +
    `0.58.0 (\`/api/minds/…\` and \`/api/extensions/…\`, now \`/api/v1/…\`), so those calls 404 ` +
    `every turn: ${files.join(", ")}.\n\n` +
    `What this costs you: your next-turn system notices are piling up undelivered rather than ` +
    `reaching you — page comments and reactions, delivery failures, skipped schedules, ` +
    `authentication problems. You have not been ignoring them; you have not been shown them.\n\n` +
    `The fix: ${repairRoute(mind)}. If you have edited one, it will be left alone — change the ` +
    `paths in it by hand (\`/api/minds/\` → \`/api/v1/minds/\`, \`/api/extensions/\` → ` +
    `\`/api/v1/extensions/\`). Once the drain hook works again, the backlog arrives on your next turn.`
  );
}

/**
 * Find minds running against removed API paths and make sure somebody who can
 * act on it actually hears about it: the host in the log, the mind itself as an
 * *immediate* event, and the spirit as a notice.
 *
 * Immediate delivery is the point. The broken direction is mind → daemon; the
 * daemon → mind POST is unaffected, so an immediate event lands even though this
 * mind's next-turn queue is exactly what is stranded. A next-turn notice here
 * would be a message about the broken mailbox, put in the broken mailbox.
 *
 * `whileSleeping: "queue"` — a sleeping mind is not woken for this. It has been
 * true for weeks; it can wait for morning.
 *
 * Never throws: each mind is handled on its own so one unreachable directory or
 * failed delivery doesn't skip the rest, and the caller is a maintenance sweep.
 */
export async function reportStaleApiPaths(): Promise<void> {
  const stale = await findMindsWithStaleApiPaths();
  if (stale.length === 0) return;

  const spirit = getSpiritName();
  for (const { mind, files } of stale) {
    slog.error(
      `${mind} still calls daemon API paths removed in 0.58.0 in ${files.length} file(s) ` +
        `(${files.join(", ")}); its next-turn system notices are not being delivered. ` +
        `${
          isSpiritName(mind)
            ? "Restart the daemon — syncSpiritTemplate refreshes these on every start (`volute mind upgrade` does not work on the spirit)"
            : `Run \`volute mind upgrade ${mind}\``
        } — unedited files are refreshed automatically; a file the mind edited is left alone ` +
        `on purpose and needs its paths updated by hand.`,
      { mind, files },
    );

    if (notified.has(mind)) continue;
    notified.add(mind);

    try {
      await deliverEvent(mind, {
        type: "notice",
        body: staleApiPathsMessage(files, mind),
        delivery: "immediate",
        whileSleeping: "queue",
        meta: { subtype: "startup", reason: "stale_api_paths", files },
      });
    } catch (err) {
      slog.warn(`failed to tell ${mind} about its stale API paths`, log.errorData(err));
    }

    if (mind === spirit) continue; // it just got the immediate event itself
    try {
      await recordNotice({
        mind: spirit,
        thread: "main",
        kind: "startup",
        reason: "stale_api_paths",
        detail:
          `${mind} is running Volute hooks that call daemon API paths removed in 0.58.0 ` +
          `(${files.join(", ")}), so its next-turn system notices are stranded. ` +
          `\`volute mind upgrade ${mind}\` will refresh any of those files ${mind} has not ` +
          `edited; an edited one has to have its paths updated by hand.`,
        meta: { subject: mind, files },
      });
    } catch (err) {
      slog.warn(`failed to notify the spirit about ${mind}'s stale API paths`, log.errorData(err));
    }
  }
}
