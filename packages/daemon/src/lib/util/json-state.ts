import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import log from "./logger.js";

/** Load a Map<string, number> from a JSON file. Returns empty map on error. */
export function loadJsonMap(path: string): Map<string, number> {
  const map = new Map<string, number>();
  try {
    if (existsSync(path)) {
      const raw = readFileSync(path, "utf-8").trim();
      // An empty/zero-length file is an expected condition (fresh install), not corruption.
      if (!raw) return map;
      const data = JSON.parse(raw);
      for (const [key, value] of Object.entries(data)) {
        if (typeof value === "number") map.set(key, value);
      }
    }
  } catch (err) {
    console.warn(`[state] failed to load ${path}:`, err);
  }
  return map;
}

/** Save a Map<string, number> to a JSON file. */
export function saveJsonMap(path: string, map: Map<string, number>): void {
  const data: Record<string, number> = {};
  for (const [key, value] of map) {
    data[key] = value;
  }
  try {
    writeFileSync(path, `${JSON.stringify(data)}\n`);
  } catch (err) {
    console.warn(`[state] failed to save ${path}:`, err);
  }
}

/** Clear a Map and delete its backing JSON file. */
export function clearJsonMap(path: string, map: Map<string, number>): void {
  map.clear();
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch (err) {
    console.warn(`[state] failed to clear ${path}:`, err);
  }
}

/**
 * Read a JSON file, or undefined when it is absent. Anything else that goes wrong (a
 * corrupt file, an unreadable one) is logged against `label` and also reads as undefined.
 */
export function readJsonFile(path: string, label: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      log.warn(`failed to read ${label}`, log.errorData(err));
    }
    return undefined;
  }
}

/** Written to a temp file and renamed over, so a crash leaves the old file or the new. */
export function writeJsonAtomic(path: string, data: unknown): void {
  const tmp = `${path}.tmp`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  renameSync(tmp, path);
}
