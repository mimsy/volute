import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { backfillInitInfrastructure } from "../template/template.js";
import { computeInfrastructureHash } from "../template/template-hash.js";
import log from "../util/logger.js";
import { chownMindDir } from "./isolation.js";
import { type MindEntry, mindDir, readRegistry, stateDir } from "./registry.js";

const ilog = log.child("infrastructure-sync");

/** Filename, inside {@link stateDir}, of the infrastructure hash a mind last received. */
const HASH_FILE = "init-infrastructure-hash.json";

/**
 * Where a mind's last-applied infrastructure hash lives.
 *
 * `stateDir`, beside the init ledger, for the same reasons the ledger lives there: it
 * is Volute's bookkeeping about the mind, not something the mind wrote, so it stays
 * out of the mind's project. It does not travel in an export — an imported mind simply
 * has no record, and the first pass runs the backfill once, which is safe by design.
 */
export function infrastructureHashPath(mindName: string): string {
  return resolve(stateDir(mindName), HASH_FILE);
}

type HashRecord = { hash?: unknown; unreadableWarned?: unknown };

function readRecord(mindName: string): HashRecord {
  const path = infrastructureHashPath(mindName);
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as HashRecord;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    // Unreadable reads as "never recorded": the next pass reruns a backfill that
    // adds only what is missing, which is the cheap direction to be wrong in.
    return {};
  }
}

/** tmp + rename, best-effort. */
function writeRecord(mindName: string, record: HashRecord): void {
  const path = infrastructureHashPath(mindName);
  const tmp = `${path}.tmp`;
  try {
    mkdirSync(resolve(path, ".."), { recursive: true });
    writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`);
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    ilog.warn(`failed to record the infrastructure hash for ${mindName}`, log.errorData(err));
  }
}

/** The infrastructure hash a mind last had applied, or null when none is recorded. */
export function readAppliedInfrastructureHash(mindName: string): string | null {
  const { hash } = readRecord(mindName);
  return typeof hash === "string" ? hash : null;
}

/** Record the infrastructure hash just applied. */
export function writeAppliedInfrastructureHash(mindName: string, hash: string): void {
  writeRecord(mindName, { hash });
}

/** The infrastructure hash whose unreadable files were last warned about, if any. */
export function readUnreadableWarnedHash(mindName: string): string | null {
  const { unreadableWarned } = readRecord(mindName);
  return typeof unreadableWarned === "string" ? unreadableWarned : null;
}

/** Record that unreadable files were warned about under `hash`, keeping the applied hash. */
export function writeUnreadableWarnedHash(mindName: string, hash: string): void {
  writeRecord(mindName, { ...readRecord(mindName), unreadableWarned: hash });
}

/** Collaborators of {@link syncMindInfrastructure}, injectable for tests. */
export type SyncInfrastructureDeps = {
  currentHash: (template: string) => string;
  appliedHash: (name: string) => string | null;
  recordHash: (name: string, hash: string) => void;
  warnedHash: (name: string) => string | null;
  recordWarned: (name: string, hash: string) => void;
  backfill: typeof backfillInitInfrastructure;
  chown: (dir: string, name: string) => Promise<void>;
};

const defaultDeps: SyncInfrastructureDeps = {
  currentHash: computeInfrastructureHash,
  appliedHash: readAppliedInfrastructureHash,
  recordHash: writeAppliedInfrastructureHash,
  warnedHash: readUnreadableWarnedHash,
  recordWarned: writeUnreadableWarnedHash,
  backfill: backfillInitInfrastructure,
  chown: chownMindDir,
};

/**
 * Bring one mind's `.local/` infrastructure up to the template's, if the template's
 * infrastructure has changed since this mind last received it. Never throws.
 *
 * Only the backfill runs — never a template merge — so a hook-only release costs a
 * mind nothing but its hooks: missing ones added, unedited ones refreshed, removed
 * ones left removed (see {@link backfillInitInfrastructure}).
 *
 * The hash is recorded only once the whole run has succeeded, so anything short of
 * that is retried at the next start: a backfill that throws, a file it could not read,
 * or a chown that fails. An unreadable file is warned about once per hash, not once
 * per start. The chown covers `home/.local` whenever the hash was stale,
 * not only when this run wrote something — a retry after a failed chown writes
 * nothing, and gating on writes would record the hash over root-owned hooks the mind
 * could then never edit.
 */
export async function syncMindInfrastructure(
  entry: MindEntry,
  deps: SyncInfrastructureDeps = defaultDeps,
): Promise<void> {
  const template = entry.template ?? "claude";
  const dir = mindDir(entry.name);
  const home = resolve(dir, "home");
  if (!existsSync(home)) return;

  try {
    const current = deps.currentHash(template);
    if (deps.appliedHash(entry.name) === current) return;

    const { added, refreshed, withheld, unreadable } = await deps.backfill(
      home,
      template,
      entry.name,
    );
    if (added.length > 0 || refreshed.length > 0) {
      ilog.info(
        `backfilled ${added.length} missing and refreshed ${refreshed.length} stale ` +
          `infrastructure files for ${entry.name}`,
        { added, refreshed, withheld },
      );
    } else if (withheld.length > 0) {
      ilog.debug(`withheld ${withheld.length} infrastructure files ${entry.name} removed`, {
        withheld,
      });
    }
    const local = resolve(home, ".local");
    if (existsSync(local)) await deps.chown(local, entry.name);
    if (unreadable.length > 0) {
      // Retried every start, but warned about once per infrastructure hash: a link or
      // FIFO the mind planted under `.local/` stays unreadable for good, and a warning
      // on every start forever says nothing the first one didn't (#1266).
      const msg = `could not read ${unreadable.length} infrastructure files for ${entry.name}`;
      if (deps.warnedHash(entry.name) === current) {
        ilog.debug(msg, { unreadable });
      } else {
        ilog.warn(msg, { unreadable });
        deps.recordWarned(entry.name, current);
      }
      return;
    }
    deps.recordHash(entry.name, current);
  } catch (err) {
    ilog.warn(`failed to sync infrastructure files for ${entry.name}`, log.errorData(err));
  }
}

/**
 * Daemon-start pass: give every mind the template's current `.init/.local/`
 * infrastructure (#960).
 *
 * The template hash that drives staleness and auto-upgrade excludes `.init/`, so a
 * release that changes only a hook or shim would otherwise reach no existing mind
 * until some unrelated `src/` change forced an upgrade — the #808 shape, where the
 * daemon half of a capability ships and looks healthy while every older mind lacks
 * the hook that reads it. Templates ship with the daemon, so a start is the only
 * moment the infrastructure can have changed.
 *
 * Runs regardless of `"upgrades": "manual"`: that opts a mind out of merges into its
 * own `src/`, while `.local/` is Volute's machinery namespace, coupled to the daemon's
 * API rather than to the mind's code, and the backfill already leaves every file the
 * mind edited or removed alone. The spirit is skipped because `syncSpiritTemplate()`
 * backfills it on every start; variants are skipped by `readRegistry()`. `shouldStop`
 * is checked between minds so a shutdown during boot doesn't wait on the whole walk.
 */
export async function syncAllMindInfrastructure(
  shouldStop: () => boolean = () => false,
): Promise<void> {
  let entries: MindEntry[];
  try {
    entries = await readRegistry();
  } catch (err) {
    ilog.error("failed to read registry for infrastructure sync", log.errorData(err));
    return;
  }
  for (const entry of entries) {
    if (shouldStop()) return;
    if (entry.mindType === "spirit") continue;
    await syncMindInfrastructure(entry);
  }
}
