import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import log from "../util/logger.js";
import { stateDir } from "./registry.js";

const llog = log.child("init-ledger");

/** Filename of the per-mind ledger inside {@link stateDir}. */
const LEDGER_FILE = "init-infrastructure.json";

type LedgerFile = { given?: unknown };

/**
 * Where a mind's infrastructure ledger lives.
 *
 * `stateDir(name)` — `~/.volute/system/state/<name>/` — is Volute's own
 * namespace, deliberately outside the mind's project directory. The ledger
 * cannot live in `home/.local/`: that subtree *is* the thing being tracked, so a
 * ledger there would be an infrastructure file the backfill would happily add
 * back after the mind deleted it. It also must not live in `home/` at all, or a
 * mind reading its own working tree would meet a bookkeeping file it never wrote.
 *
 * The spirit resolves the same way: `stateDir()` is keyed on the mind's name and
 * makes no assumption about where its project directory is, so it works for the
 * spirit (which lives under `voluteSystemDir()/spirit`, not in the minds dir).
 */
export function initLedgerPath(mindName: string): string {
  return resolve(stateDir(mindName), LEDGER_FILE);
}

/** `.init/`-relative paths use forward slashes regardless of host separator. */
function normalize(relPath: string): string {
  return relPath.split(sep).join("/");
}

/**
 * The set of infrastructure paths this mind has *ever* been given.
 *
 * This is what turns absence into an answerable question. `backfillInitInfrastructure`
 * adds a `.local/` file whenever it is missing, and absence alone cannot tell
 * "this mind predates the hook" (add it — #808) from "this mind deleted the hook
 * on purpose" (adding it back overrides the mind's own authorship — #811). With
 * the ledger the two separate cleanly:
 *
 * - **in the ledger and absent** — we gave it, the mind removed it. Deliberate. Skip.
 * - **not in the ledger and absent** — the mind never had it. Add it.
 *
 * A missing or unparseable ledger degrades to the empty set, the same way
 * `readShippedHashes` degrades: the mind gets its infrastructure back once and
 * the ledger is rewritten from what is on disk, rather than a corrupt file
 * permanently withholding files. Self-healing at the cost of one re-add.
 */
export function readInitLedger(mindName: string): Set<string> {
  const path = initLedgerPath(mindName);
  if (!existsSync(path)) return new Set();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as LedgerFile;
    const given = parsed?.given;
    if (!Array.isArray(given)) return new Set();
    return new Set(given.filter((p): p is string => typeof p === "string").map(normalize));
  } catch (err) {
    llog.warn(`failed to read the infrastructure ledger for ${mindName}`, log.errorData(err));
    return new Set();
  }
}

/**
 * Persist a mind's infrastructure ledger, replacing whatever was there.
 *
 * Only ever called with paths whose files were on disk during the run that wrote
 * them — observed present, or installed successfully moments before. That
 * invariant is the whole safety property: a ledger entry for a file that never
 * landed reads as "given, then deleted" and would withhold that file forever.
 *
 * Written to a sibling temp file and renamed over the real one, so a crash or a
 * full disk leaves either the old ledger or the new one, never half of either.
 * A truncated write would parse as corrupt and degrade to the empty set — which
 * would silently undo the removals this file exists to remember.
 *
 * Best-effort otherwise. A ledger that cannot be written means the next run
 * re-derives it from disk, which is the same degraded behaviour as no ledger at
 * all — worth a warning, never worth failing an upgrade over.
 */
export function writeInitLedger(mindName: string, given: Iterable<string>): void {
  const path = initLedgerPath(mindName);
  const tmp = `${path}.tmp`;
  try {
    mkdirSync(resolve(path, ".."), { recursive: true });
    const sorted = [...new Set([...given].map(normalize))].sort();
    writeFileSync(tmp, `${JSON.stringify({ given: sorted }, null, 2)}\n`);
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    llog.warn(`failed to write the infrastructure ledger for ${mindName}`, log.errorData(err));
  }
}

/**
 * Seed a newly created mind's ledger from the infrastructure paths
 * `applyInitFiles` just gave it.
 *
 * Deliberately a replace, not a merge: a mind deleted and recreated under the
 * same name is a new mind, and must not inherit the old one's removals.
 *
 * Without this, a mind that deletes a hook before its first backfill (for a
 * regular mind, its first `volute mind upgrade` — possibly weeks away) would
 * have that deletion read as "never had it" and undone. Seeding at creation
 * makes a removal durable from the mind's first day.
 */
export function seedInitLedger(mindName: string, appliedRelPaths: Iterable<string>): void {
  writeInitLedger(mindName, appliedRelPaths);
}
