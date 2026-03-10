import { existsSync, mkdirSync, renameSync } from "node:fs";
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

/**
 * Migrate infrastructure files from ~/.volute/ to ~/.volute/system/.
 * Uses rename() for atomic moves on the same filesystem.
 * Idempotent — skips files that already exist in the new location.
 */
export function migrateToSystemDir(): void {
  const home = voluteHome();
  const systemDir = voluteSystemDir();

  mkdirSync(systemDir, { recursive: true });

  // Migrate individual files
  for (const file of FILES_TO_MIGRATE) {
    const oldPath = resolve(home, file);
    const newPath = resolve(systemDir, file);
    if (existsSync(oldPath) && !existsSync(newPath)) {
      try {
        renameSync(oldPath, newPath);
      } catch {
        // May fail if cross-device — not fatal, daemon will recreate
      }
    }
  }

  // Migrate state/ directory
  const oldStateDir = resolve(home, "state");
  const newStateDir = resolve(systemDir, "state");
  if (existsSync(oldStateDir) && !existsSync(newStateDir)) {
    try {
      renameSync(oldStateDir, newStateDir);
    } catch {
      // May fail if cross-device — not fatal
    }
  }
}
