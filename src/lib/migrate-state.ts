import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import { resolve } from "node:path";
import { mindDir, stateDir } from "./registry.js";

/** Rename legacy .volute/ → .mind/ within a mind directory. */
export function migrateDotVoluteDir(name: string): void {
  const dir = mindDir(name);
  const oldDir = resolve(dir, ".volute");
  const newDir = resolve(dir, ".mind");
  if (existsSync(oldDir) && !existsSync(newDir)) {
    renameSync(oldDir, newDir);
  }
}

/** Migrate system state files from mind's .mind/ to the centralized state dir. */
export function migrateMindState(name: string): void {
  const src = resolve(mindDir(name), ".mind");
  if (!existsSync(src)) return;

  const dest = stateDir(name);
  mkdirSync(dest, { recursive: true });

  for (const file of ["env.json", "channels.json"]) {
    const srcPath = resolve(src, file);
    const destPath = resolve(dest, file);
    if (existsSync(srcPath) && !existsSync(destPath)) {
      copyFileSync(srcPath, destPath);
    }
  }

  // Migrate logs directory
  const srcLogs = resolve(src, "logs");
  const destLogs = resolve(dest, "logs");
  if (existsSync(srcLogs) && !existsSync(destLogs)) {
    mkdirSync(destLogs, { recursive: true });
    for (const file of readdirSync(srcLogs)) {
      try {
        copyFileSync(resolve(srcLogs, file), resolve(destLogs, file));
      } catch (err) {
        console.error(`[migrate] failed to copy log ${file} for ${name}:`, err);
      }
    }
  }
}
