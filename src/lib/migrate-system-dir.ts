import { execSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { voluteHome, voluteSystemDir } from "./registry.js";

const FILES_TO_MIGRATE = [
  "volute.db",
  "volute.db-wal",
  "volute.db-shm",
  "minds.json",
  "config.json",
  "daemon.json",
  "daemon.pid",
  "daemon.log",
  "env.json",
  "variants.json",
  "version-notify.json",
  "update-check.json",
  "crash-attempts.json",
  "scheduler-state.json",
  "sleep-state.json",
];

function moveFile(oldPath: string, newPath: string): void {
  try {
    renameSync(oldPath, newPath);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "EXDEV") {
      copyFileSync(oldPath, newPath);
      rmSync(oldPath);
    } else {
      throw err;
    }
  }
}

function moveDir(oldPath: string, newPath: string): void {
  try {
    renameSync(oldPath, newPath);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "EXDEV") {
      execSync(`cp -a ${JSON.stringify(oldPath)} ${JSON.stringify(newPath)}`);
      rmSync(oldPath, { recursive: true, force: true });
    } else {
      throw err;
    }
  }
}

/**
 * Migrate infrastructure files from ~/.volute/ to ~/.volute/system/.
 * Uses rename() for atomic moves on the same filesystem.
 * Falls back to copy+delete for cross-device moves.
 * Idempotent — skips files that already exist in the new location.
 */
export function migrateToSystemDir(): void {
  const home = voluteHome();
  const systemDir = voluteSystemDir();

  mkdirSync(systemDir, { recursive: true });

  for (const file of FILES_TO_MIGRATE) {
    const oldPath = resolve(home, file);
    const newPath = resolve(systemDir, file);
    if (existsSync(oldPath) && !existsSync(newPath)) {
      try {
        moveFile(oldPath, newPath);
      } catch (err) {
        console.error(`Failed to migrate ${file}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  const oldStateDir = resolve(home, "state");
  const newStateDir = resolve(systemDir, "state");
  if (existsSync(oldStateDir) && !existsSync(newStateDir)) {
    try {
      moveDir(oldStateDir, newStateDir);
    } catch (err) {
      console.error(`Failed to migrate state/: ${err instanceof Error ? err.message : err}`);
    }
  }
}
