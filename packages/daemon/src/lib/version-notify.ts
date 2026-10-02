import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { deliverEvent } from "./chat/system-events.js";
import { mindFileOwner } from "./mind/isolation.js";
import { readMindFile, replaceMindFile } from "./mind/mind-file-write.js";
import {
  findMind,
  mindDir,
  readRegistry,
  setMindTemplateHash,
  stateDir,
  voluteSystemDir,
} from "./mind/registry.js";
import { computeMindTemplateHash } from "./mind/template-staleness.js";
import { readVoluteConfig } from "./mind/volute-config.js";
import { formatReleaseNotes, parseReleaseNotesSince } from "./release-notes.js";
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

/** Filename, inside {@link stateDir}, of the last Volute version a mind was told about. */
const MIND_RECORD_FILE = "version-notified.json";

/**
 * The last version this mind was told about, or null when nothing is recorded.
 *
 * `stateDir`, beside the infrastructure hash: it is Volute's bookkeeping about the mind,
 * not something the mind wrote. The mind owns that directory under user isolation, so
 * the record is read and written through the mind-file helpers.
 */
async function readMindNotifiedVersion(name: string): Promise<string | null> {
  if (!existsSync(stateDir(name))) return null;
  try {
    const file = await readMindFile(stateDir(name), MIND_RECORD_FILE, {
      owner: await mindFileOwner(name),
    });
    const version = file ? JSON.parse(file.text)?.version : null;
    return typeof version === "string" ? version : null;
  } catch (err) {
    // Unreadable reads as "never recorded" — which, for a mind starting late, means it
    // is recorded at the current version without being told. Say so.
    log.warn(`failed to read the notified version for ${name}`, log.errorData(err));
    return null;
  }
}

async function writeMindNotifiedVersion(name: string, version: string): Promise<void> {
  try {
    mkdirSync(stateDir(name), { recursive: true });
    await replaceMindFile(stateDir(name), MIND_RECORD_FILE, `${JSON.stringify({ version })}\n`, {
      owner: await mindFileOwner(name),
    });
  } catch (err) {
    log.warn(`failed to record the notified version for ${name}`, log.errorData(err));
  }
}

/**
 * Whether the boot pass has seeded every mind's record. Until then a start must not
 * notify: the boot mind loop runs before the infrastructure sync (#960) and before the
 * seeding, and a pre-record mind starting then would be recorded as already told.
 * Starts in that window are remembered in `startedEarly` and handled by the pass.
 */
let seeded = false;
const startedEarly = new Set<string>();
const inFlight = new Set<string>();
const releaseNotes = new Map<string, string | null>();

/** Test-only: forget the boot pass and any pending or in-flight notices. */
export function resetVersionNotifyState(): void {
  seeded = false;
  startedEarly.clear();
  inFlight.clear();
  releaseNotes.clear();
}

/**
 * Tell one mind about the current Volute version, once, if it hasn't been told — with
 * the release notes of every version since the one it was last told about.
 *
 * Called by the boot pass for minds running then, and on every later start and wake —
 * so a mind that was stopped or asleep through an upgrade still learns what changed
 * when it comes back. A mind with no record at all is one created since the boot pass:
 * it was born into this version and has nothing to be told, so it is recorded silently.
 * Base minds and the spirit only: seeds hear about Volute through orientation, and a
 * variant's parent is told.
 *
 * `autoUpgradePending`: whether the boot auto-upgrade pass is still ahead. A mind
 * started later and still on a stale template was not (or could not be) upgraded by it,
 * so it is told to upgrade itself rather than promised an upgrade nothing will run.
 */
export async function notifyMindOfVersion(
  name: string,
  { autoUpgradePending = false }: { autoUpgradePending?: boolean } = {},
): Promise<void> {
  if (!seeded) {
    startedEarly.add(name);
    return;
  }
  if (inFlight.has(name)) return;
  inFlight.add(name);
  try {
    const entry = await findMind(name);
    if (!entry || entry.parent || entry.stage === "seed") return;

    const currentVersion = getCurrentVersion();
    const told = await readMindNotifiedVersion(name);
    if (told === currentVersion) return;
    if (told == null) {
      await writeMindNotifiedVersion(name, currentVersion);
      return;
    }

    const tmpl = entry.template ?? "claude";
    let currentHash: string | undefined;
    try {
      currentHash = computeTemplateHash(tmpl);
    } catch (err) {
      log.warn(`failed to compute template hash for ${tmpl}`, log.errorData(err));
    }
    // Everything since the version it was last told, not just this one (#1350).
    if (!releaseNotes.has(told)) {
      releaseNotes.set(
        told,
        formatReleaseNotes(parseReleaseNotesSince(told, currentVersion), told),
      );
    }
    const message = formatNotification(
      currentVersion,
      releaseNotes.get(told) ?? null,
      shouldSuggestUpgrade(entry, currentHash),
      name,
      autoUpgradePending && readVoluteConfig(mindDir(name))?.upgrades !== "manual",
    );

    // Immediate (triggers a turn): an idle mind — exactly the stale mind that needs the
    // upgrade nudge — never drains a next-turn event, and pre-events templates lack the
    // drain hook entirely, so next-turn delivery could not reach the minds that need it.
    // An event that was stored but not delivered stays pending for the next start or
    // wake; one that was never stored isn't recorded, so the next start tries again.
    const { id } = await deliverEvent(name, { type: "version", body: message });
    if (id != null) await writeMindNotifiedVersion(name, currentVersion);
  } finally {
    inFlight.delete(name);
  }
}

/**
 * Boot pass: notify minds running now about a Volute version update.
 *
 * Every base mind without a record is first recorded as told about the version the
 * system last announced — what it last heard, or would have, had it been up — so a
 * mind stopped or asleep now is told when it next starts ({@link notifyMindOfVersion}).
 * On first run there is nothing to announce: everyone is recorded at the current version.
 */
export async function notifyVersionUpdate(): Promise<void> {
  const currentVersion = getCurrentVersion();
  const previous = readState()?.lastNotifiedVersion ?? currentVersion;

  const entries = (await readRegistry()).filter((e) => !e.parent && e.stage !== "seed");
  for (const entry of entries) {
    if ((await readMindNotifiedVersion(entry.name)) == null) {
      await writeMindNotifiedVersion(entry.name, previous);
    }
  }
  seeded = true;

  const names = new Set([...entries.filter((e) => e.running).map((e) => e.name), ...startedEarly]);
  startedEarly.clear();
  const results = await Promise.allSettled(
    [...names].map((name) => notifyMindOfVersion(name, { autoUpgradePending: true })),
  );
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

/**
 * Format the version-update message sent to a mind. When a template update is
 * available, the hint differs by whether the mind has opted out of the
 * post-startup auto-upgrade pass (`autoUpgrade` — see readVoluteConfig's
 * `upgrades` field): opted-in minds are told the upgrade is automatic,
 * opted-out minds are told to run it themselves.
 */
export function formatNotification(
  version: string,
  releaseNotes: string | null,
  needsUpgrade: boolean,
  mindName: string,
  autoUpgrade: boolean,
): string {
  let message = `Volute has been updated to v${version}.`;

  if (releaseNotes) {
    message += `\n\n${releaseNotes}`;
  }

  if (needsUpgrade) {
    message += autoUpgrade
      ? `\n\n---\n\nA template update is available. It will be applied automatically in a few minutes (set "upgrades": "manual" in home/.config/volute.json to manage upgrades yourself).`
      : `\n\n---\n\nA template update is available for you. To upgrade, run:\n  volute mind upgrade ${mindName}`;
  }

  return message;
}
