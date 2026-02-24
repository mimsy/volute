import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { deliverMessage } from "./delivery/message-delivery.js";
import log from "./logger.js";
import { readRegistry, voluteHome, writeRegistry } from "./registry.js";
import { parseReleaseNotes } from "./release-notes.js";
import { computeTemplateHash } from "./template-hash.js";
import { getCurrentVersion } from "./update-check.js";

type VersionNotifyState = {
  lastNotifiedVersion: string;
};

function statePath(): string {
  return resolve(voluteHome(), "version-notify.json");
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
 * Backfill templateHash for minds that don't have one.
 * Uses the current template hash so existing minds won't get a false upgrade notification.
 */
export function backfillTemplateHashes(): void {
  const entries = readRegistry();
  let changed = false;

  for (const entry of entries) {
    if (entry.templateHash != null) continue;
    if (entry.stage === "seed") continue;

    const tmpl = entry.template ?? "claude";
    try {
      entry.templateHash = computeTemplateHash(tmpl);
      changed = true;
    } catch (err) {
      log.warn(`failed to compute template hash for ${entry.name}`, log.errorData(err));
    }
  }

  if (changed) {
    writeRegistry(entries);
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

  const entries = readRegistry();
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
    const needsUpgrade =
      entry.templateHash != null && currentHash != null && entry.templateHash !== currentHash;

    const message = formatNotification(currentVersion, releaseNotes, needsUpgrade, entry.name);

    await deliverMessage(entry.name, {
      channel: "system:version",
      sender: "volute",
      content: message,
    });
  });

  const results = await Promise.allSettled(promises);
  for (const result of results) {
    if (result.status === "rejected") {
      log.warn("failed to notify mind about version update", log.errorData(result.reason));
    }
  }

  writeState({ lastNotifiedVersion: currentVersion });
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
    message += `\n\n---\n\nA template update is available for you. To upgrade, your operator can run:\n  volute mind upgrade ${mindName}`;
  }

  return message;
}
