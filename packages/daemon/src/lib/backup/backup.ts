import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { sql } from "drizzle-orm";
import { type BackupConfig, readGlobalConfig } from "../config/setup.js";
import { getDb } from "../db.js";
import { readAllMinds, voluteHome, voluteSystemDir } from "../mind/registry.js";
import log from "../util/logger.js";
import { runRestic, writeExcludeFile } from "./restic.js";

const blog = log.child("backup");

export type BackupState = {
  /** Last successful run — these three always describe the same run. */
  lastRun?: string;
  lastSnapshotId?: string;
  lastDurationMs?: number;
  /** Last failed attempt. */
  lastAttempt?: string;
  lastError?: string;
  /** Set when the snapshot succeeded but retention pruning failed. */
  pruneError?: string;
};

export type BackupSummary = {
  snapshotId: string;
  filesNew: number;
  filesChanged: number;
  dataAdded: number;
  totalFilesProcessed: number;
  durationMs: number;
};

export type Snapshot = {
  id: string;
  short_id: string;
  time: string;
  hostname: string;
  paths: string[];
};

const DEFAULT_KEEP = { daily: 7, weekly: 4, monthly: 12 };

function stateFilePath(): string {
  return resolve(voluteSystemDir(), "backup-state.json");
}

export function readBackupState(): BackupState {
  const path = stateFilePath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    blog.warn("backup-state.json unreadable, treating as empty", log.errorData(err));
    return {};
  }
}

/** Never throws: a state-bookkeeping failure must not mask the run's real outcome. */
function writeBackupState(state: BackupState): void {
  try {
    writeFileSync(stateFilePath(), `${JSON.stringify(state, null, 2)}\n`);
  } catch (err) {
    blog.error("failed to write backup-state.json", log.errorData(err));
  }
}

export function stagingDir(): string {
  return resolve(voluteSystemDir(), "backup-staging");
}

/**
 * Produce consistent copies of every live SQLite DB into backup-staging/,
 * mirroring their real layout so restore is a mechanical move-back. Raw file
 * copies of a WAL database are not safe; VACUUM INTO is.
 */
export async function stageDatabases(): Promise<string[]> {
  const staging = stagingDir();
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });

  const staged: string[] = [];

  // Main system DB via the daemon's own connection.
  const mainTarget = resolve(staging, "volute.db");
  const db = await getDb();
  await db.run(sql.raw(`VACUUM INTO '${mainTarget.replaceAll("'", "''")}'`));
  staged.push(mainTarget);

  // Extension DBs: enumerate on disk (covers disabled extensions too) and
  // vacuum each through a fresh libsql connection.
  const extDataDir = resolve(voluteSystemDir(), "extension-data");
  if (existsSync(extDataDir)) {
    const { default: Database } = await import("libsql");
    for (const id of readdirSync(extDataDir)) {
      const dbPath = resolve(extDataDir, id, "data.db");
      if (!existsSync(dbPath)) continue;
      const target = resolve(staging, "extension-data", id, "data.db");
      mkdirSync(dirname(target), { recursive: true });
      const extDb = new Database(dbPath);
      try {
        extDb.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
        staged.push(target);
      } finally {
        extDb.close();
      }
    }
  }

  return staged;
}

export async function backupRoots(): Promise<string[]> {
  const roots = new Set<string>([voluteHome()]);
  const mindsDir = process.env.VOLUTE_MINDS_DIR;
  if (mindsDir && existsSync(mindsDir)) roots.add(resolve(mindsDir));
  // Minds with a custom dir outside the standard roots (e.g. imported minds).
  for (const mind of await readAllMinds()) {
    if (!mind.dir || !existsSync(mind.dir)) continue;
    const dir = resolve(mind.dir);
    if (![...roots].some((root) => dir === root || dir.startsWith(`${root}/`))) {
      roots.add(dir);
    }
  }
  return [...roots];
}

let backupInFlight = false;

export async function runBackup(): Promise<BackupSummary> {
  if (backupInFlight) throw new Error("A backup is already running");
  backupInFlight = true;
  const started = Date.now();
  try {
    const config = readGlobalConfig().backup ?? {};
    if (!config.repository || !config.password) {
      throw new Error("Backup repository is not configured. Run: volute backup init");
    }
    blog.info("starting backup", { repository: config.repository });

    await stageDatabases();
    const roots = await backupRoots();
    const excludeFile = writeExcludeFile(config);

    const out = await runRestic(
      [
        "backup",
        ...roots,
        "--exclude-file",
        excludeFile,
        "--exclude-caches",
        "--tag",
        "volute",
        "--json",
      ],
      config,
    );
    const summary = parseBackupSummary(out, Date.now() - started);

    // Retention pruning is separate from the backup: the snapshot already
    // exists, so a prune failure (e.g. repo lock contention) must not report
    // the backup itself as failed or leave the snapshot unrecorded.
    const keep = { ...DEFAULT_KEEP, ...config.keep };
    let pruneError: string | undefined;
    try {
      await runRestic(
        [
          "forget",
          "--tag",
          "volute",
          "--keep-daily",
          String(keep.daily),
          "--keep-weekly",
          String(keep.weekly),
          "--keep-monthly",
          String(keep.monthly),
          "--prune",
        ],
        config,
      );
    } catch (err) {
      pruneError = err instanceof Error ? err.message : String(err);
      blog.warn("retention prune failed (snapshot is intact)", log.errorData(err));
    }

    writeBackupState({
      lastRun: new Date().toISOString(),
      lastSnapshotId: summary.snapshotId,
      lastDurationMs: summary.durationMs,
      ...(pruneError ? { pruneError } : {}),
    });
    blog.info("backup complete", { snapshot: summary.snapshotId, ms: summary.durationMs });
    return summary;
  } catch (err) {
    writeBackupState({
      ...readBackupState(),
      lastAttempt: new Date().toISOString(),
      lastError: err instanceof Error ? err.message : String(err),
    });
    throw err;
  } finally {
    backupInFlight = false;
  }
}

/** Parse the summary line from `restic backup --json` output. */
function parseBackupSummary(output: string, durationMs: number): BackupSummary {
  for (const line of output.trim().split("\n").reverse()) {
    let msg: {
      message_type?: string;
      snapshot_id?: string;
      files_new?: number;
      files_changed?: number;
      data_added?: number;
      total_files_processed?: number;
    };
    try {
      msg = JSON.parse(line);
    } catch {
      continue; // non-JSON line (progress noise) — keep scanning
    }
    if (msg.message_type !== "summary") continue;
    if (!msg.snapshot_id) throw new Error("restic summary is missing snapshot_id");
    return {
      snapshotId: msg.snapshot_id,
      filesNew: msg.files_new ?? 0,
      filesChanged: msg.files_changed ?? 0,
      dataAdded: msg.data_added ?? 0,
      totalFilesProcessed: msg.total_files_processed ?? 0,
      durationMs,
    };
  }
  throw new Error("restic backup produced no summary");
}

export async function listSnapshots(): Promise<Snapshot[]> {
  const config = readGlobalConfig().backup ?? {};
  const out = await runRestic(["snapshots", "--tag", "volute", "--json"], config);
  const parsed = JSON.parse(out || "[]") as Snapshot[];
  return parsed.map((s) => ({
    id: s.id,
    short_id: s.short_id,
    time: s.time,
    hostname: s.hostname,
    paths: s.paths,
  }));
}

/**
 * Initialize the restic repository. Takes the config explicitly so callers can
 * init with a not-yet-persisted passphrase (the API only saves a generated one
 * after init succeeds). Idempotent: an already-initialized repo is fine.
 */
export async function initRepo(config: BackupConfig): Promise<void> {
  try {
    await runRestic(["init"], config);
  } catch (err) {
    const stderr = (err as Error & { stderr?: string }).stderr ?? "";
    const msg = err instanceof Error ? err.message : String(err);
    if (/already exists|already initialized/i.test(stderr + msg)) return;
    throw err;
  }
}

/**
 * Move a staged DB copy into its live location, clearing stale WAL/SHM files
 * so a leftover journal can't corrupt the restored database on next open.
 * Returns false — without touching the live DB — when the staged copy is
 * missing; the caller decides whether that is fatal.
 */
export function restoreStagedDb(stagedPath: string, livePath: string): boolean {
  if (!existsSync(stagedPath)) return false;
  mkdirSync(dirname(livePath), { recursive: true });
  rmSync(livePath, { force: true });
  rmSync(`${livePath}-wal`, { force: true });
  rmSync(`${livePath}-shm`, { force: true });
  renameSync(stagedPath, livePath);
  return true;
}
