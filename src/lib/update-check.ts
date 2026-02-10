import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { voluteHome } from "./registry.js";

type UpdateCheckResult = {
  current: string;
  latest: string;
  updateAvailable: boolean;
};

type UpdateCheckCache = {
  latest: string;
  checkedAt: number;
};

const CACHE_TTL = 60 * 60 * 1000; // 1 hour

function cachePath(): string {
  return resolve(voluteHome(), "update-check.json");
}

function readCache(): UpdateCheckCache | null {
  try {
    const data = JSON.parse(readFileSync(cachePath(), "utf-8"));
    if (data.latest && typeof data.checkedAt === "number") return data;
  } catch {}
  return null;
}

function writeCache(latest: string): void {
  try {
    writeFileSync(cachePath(), `${JSON.stringify({ latest, checkedAt: Date.now() })}\n`);
  } catch {}
}

export function getCurrentVersion(): string {
  // Walk up from this file to find package.json
  // In built dist: dist/lib/update-check.js → ../../package.json
  // In dev via tsx: src/lib/update-check.ts → ../../package.json
  const thisDir = new URL(".", import.meta.url).pathname;
  const candidates = [
    resolve(thisDir, "../../package.json"),
    resolve(thisDir, "../../../package.json"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      try {
        return JSON.parse(readFileSync(p, "utf-8")).version;
      } catch {}
    }
  }
  return "0.0.0";
}

export async function fetchLatestVersion(): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch("https://registry.npmjs.org/volute/latest", {
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`npm registry returned ${res.status}`);
    const data = (await res.json()) as { version: string };
    return data.version;
  } finally {
    clearTimeout(timeout);
  }
}

/** Compare two semver strings. Returns true if latest > current. */
export function isNewer(current: string, latest: string): boolean {
  const parse = (v: string) => v.split(".").map(Number);
  const c = parse(current);
  const l = parse(latest);
  for (let i = 0; i < 3; i++) {
    if ((l[i] ?? 0) > (c[i] ?? 0)) return true;
    if ((l[i] ?? 0) < (c[i] ?? 0)) return false;
  }
  return false;
}

export async function checkForUpdate(): Promise<UpdateCheckResult> {
  const current = getCurrentVersion();

  // Check cache first
  const cache = readCache();
  if (cache && Date.now() - cache.checkedAt < CACHE_TTL) {
    return {
      current,
      latest: cache.latest,
      updateAvailable: isNewer(current, cache.latest),
    };
  }

  try {
    const latest = await fetchLatestVersion();
    writeCache(latest);
    return { current, latest, updateAvailable: isNewer(current, latest) };
  } catch {
    return { current, latest: current, updateAvailable: false };
  }
}

/** Synchronous cache-only check. Returns null if no cache exists. */
export function checkForUpdateCached(): UpdateCheckResult | null {
  const cache = readCache();
  if (!cache) return null;
  const current = getCurrentVersion();
  return {
    current,
    latest: cache.latest,
    updateAvailable: isNewer(current, cache.latest),
  };
}
