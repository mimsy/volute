import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { deliverEvent } from "./chat/system-events.js";
import { mindDir, readRegistry, setMindTemplateHash, voluteSystemDir } from "./mind/registry.js";
import { computeMindTemplateHash } from "./mind/template-staleness.js";
import { parseReleaseNotes } from "./release-notes.js";
import { computeTemplateHash } from "./template/template-hash.js";
import { getCurrentVersion } from "./update-check.js";
import log from "./util/logger.js";

type VersionNotifyState = {
  lastNotifiedVersion: string;
};

function statePath(): string {
  return resolve(voluteSystemDir(), "version-notify.json");
}

function readState(): VersionNotifyState | null {
  try {
    if (!existsSync(statePath())) return null;
    return JSON.parse(readFileSync(statePath(), "utf-8"));
  } catch {
    return null;
  }
}

function writeState(state: VersionNotifyState): void {
  writeFileSync(statePath(), `${JSON.stringify(state, null, 2)}\n`);
}

/**
 * Backfill templateHash for minds that don't have one, measuring the mind's
 * actual on-disk template rather than stamping the current hash. A mind that is
 * genuinely stale is recorded as stale (not falsely current); if its files
 * can't be read, the column is left null and null reads as unknown → stale.
 */
export async function backfillTemplateHashes(): Promise<void> {
  const entries = await readRegistry();

  for (const entry of entries) {
    if (entry.templateHash != null) continue;
    if (entry.stage === "seed") continue;

    const tmpl = entry.template ?? "claude";
    try {
      const hash = computeMindTemplateHash(mindDir(entry.name), tmpl, entry.name);
      await setMindTemplateHash(entry.name, hash);
    } catch (err) {
      // Leave the column null: null reads as unknown → stale, not fresh.
      log.warn(`failed to compute on-disk template hash for ${entry.name}`, log.errorData(err));
    }
  }
}

/**
 * Log a warning at daemon start for each mind running an outdated template copy,
 * so staleness is visible in the daemon log even when nobody runs `volute status`.
 */
export async function warnStaleTemplates(): Promise<void> {
  const { isTemplateStale } = await import("./mind/template-staleness.js");
  const entries = await readRegistry();
  const stale = entries.filter((e) => isTemplateStale(e)).map((e) => e.name);
  for (const name of stale) {
    log.warn(`${name} is running an outdated template — run 'volute mind upgrade ${name}'`);
  }
}

/**
 * Notify running minds about a Volute version update.
 * On first run, records the current version without sending notifications.
 * On version change, sends release notes to all running non-seed minds.
 */
export async function notifyVersionUpdate(): Promise<void> {
  const currentVersion = getCurrentVersion();
  const state = readState();

  // First run: record version, don't notify
  if (!state) {
    writeState({ lastNotifiedVersion: currentVersion });
    return;
  }

  // Version unchanged: nothing to do
  if (state.lastNotifiedVersion === currentVersion) return;

  const entries = await readRegistry();
  const runningMinds = entries.filter((e) => e.running && e.stage !== "seed");

  if (runningMinds.length === 0) {
    writeState({ lastNotifiedVersion: currentVersion });
    return;
  }

  // Parse release notes (may be null if CHANGELOG missing or version not found)
  const releaseNotes = parseReleaseNotes(currentVersion);

  // Compute current template hashes (memoized, at most 2 calls for claude/pi)
  const templateHashes = new Map<string, string>();
  for (const entry of runningMinds) {
    const tmpl = entry.template ?? "claude";
    if (!templateHashes.has(tmpl)) {
      try {
        templateHashes.set(tmpl, computeTemplateHash(tmpl));
      } catch (err) {
        log.warn(`failed to compute template hash for ${tmpl}`, log.errorData(err));
      }
    }
  }

  // Send notifications
  const promises = runningMinds.map(async (entry) => {
    const tmpl = entry.template ?? "claude";
    const currentHash = templateHashes.get(tmpl);
    const needsUpgrade = shouldSuggestUpgrade(entry, currentHash);

    const message = formatNotification(currentVersion, releaseNotes, needsUpgrade, entry.name);

    // Informational — no reason to trigger a turn; drained on the mind's next turn.
    await deliverEvent(entry.name, { type: "version", body: message, delivery: "next-turn" });
  });

  const results = await Promise.allSettled(promises);
  for (const result of results) {
    if (result.status === "rejected") {
      log.warn("failed to notify mind about version update", log.errorData(result.reason));
    }
  }

  writeState({ lastNotifiedVersion: currentVersion });
}

/**
 * Whether to suggest `volute mind upgrade` to a mind on a template-hash change.
 *
 * The spirit is excluded: it upgrades via syncSpiritTemplate() on daemon restart,
 * not `volute mind upgrade`. It still receives the release notes (this only
 * controls the upgrade hint).
 */
export function shouldSuggestUpgrade(
  entry: { mindType: string; templateHash?: string | null },
  currentHash: string | null | undefined,
): boolean {
  return (
    entry.mindType !== "spirit" &&
    entry.templateHash != null &&
    currentHash != null &&
    entry.templateHash !== currentHash
  );
}

function formatNotification(
  version: string,
  releaseNotes: string | null,
  needsUpgrade: boolean,
  mindName: string,
): string {
  let message = `Volute has been updated to v${version}.`;

  if (releaseNotes) {
    message += `\n\n${releaseNotes}`;
  }

  if (needsUpgrade) {
    message += `\n\n---\n\nA template update is available for you. To upgrade, run:\n  volute mind upgrade ${mindName}`;
  }

  return message;
}
