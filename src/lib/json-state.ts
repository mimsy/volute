import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";

/** Load a Map<string, number> from a JSON file. Returns empty map on error. */
export function loadJsonMap(path: string): Map<string, number> {
  const map = new Map<string, number>();
  try {
    if (existsSync(path)) {
      const data = JSON.parse(readFileSync(path, "utf-8"));
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
