import { execFile as execFileCb, execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { voluteSystemDir } from "./mind/registry.js";

const execFile = promisify(execFileCb);

type UpdateCheckResult = {
  current: string;
  latest: string;
  updateAvailable: boolean;
  checkFailed?: boolean;
};

type UpdateCheckCache = {
  latest: string;
  checkedAt: number;
};

const CACHE_TTL = 60 * 60 * 1000; // 1 hour

function cachePath(): string {
  return resolve(voluteSystemDir(), "update-check.json");
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
  // In built dist (flat with splitting): dist/chunk-*.js → ../package.json
  // In dev via tsx: src/lib/update-check.ts → ../../package.json
  const thisDir = new URL(".", import.meta.url).pathname;
  const candidates = [
    resolve(thisDir, "../package.json"),
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
  timeout.unref?.();
  try {
    const res = await fetch("https://registry.npmjs.org/volute/latest", {
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`npm registry returned ${res.status}`);
    const data = (await res.json()) as { version: string };
    if (typeof data.version !== "string") throw new Error("invalid npm response");
    return data.version;
  } finally {
    clearTimeout(timeout);
  }
}

/** Compare two semver version strings (MAJOR.MINOR.PATCH). Pre-release suffixes are stripped. Returns true if latest > current. */
export function isNewer(current: string, latest: string): boolean {
  const parse = (v: string) => v.split("-")[0].split(".").map(Number);
  const hasPrerelease = (v: string) => v.includes("-");
  const c = parse(current);
  const l = parse(latest);
  for (let i = 0; i < 3; i++) {
    if ((l[i] ?? 0) > (c[i] ?? 0)) return true;
    if ((l[i] ?? 0) < (c[i] ?? 0)) return false;
  }
  // Same numeric version: release is newer than pre-release
  if (hasPrerelease(current) && !hasPrerelease(latest)) return true;
  return false;
}

export async function checkForUpdate(force = false): Promise<UpdateCheckResult> {
  const current = getCurrentVersion();

  // Check cache first (skip if forced)
  if (!force) {
    const cache = readCache();
    if (cache && Date.now() - cache.checkedAt < CACHE_TTL) {
      return {
        current,
        latest: cache.latest,
        updateAvailable: isNewer(current, cache.latest),
      };
    }
  }

  try {
    const latest = await fetchLatestVersion();
    writeCache(latest);
    return { current, latest, updateAvailable: isNewer(current, latest) };
  } catch {
    return { current, latest: current, updateAvailable: false, checkFailed: true };
  }
}

export type VoluteInstall = {
  /** Path resolved by `which volute` (may be a symlink, e.g. /opt/homebrew/bin/volute). */
  binPath: string;
  /** Symlinks resolved (e.g. /opt/homebrew/lib/node_modules/volute/dist/cli.js). */
  realPath: string;
  /** The `volute` package directory, or null for a linked/source checkout. */
  packageRoot: string | null;
  /** The npm global prefix that owns the running binary (e.g. /opt/homebrew), or null. */
  prefix: string | null;
  /** Version read from the running binary's package.json, or null if unreadable. */
  version: string | null;
  /** True when the binary is run from a source checkout / `npm link` rather than a real -g install. */
  isLinked: boolean;
};

function readPackageVersion(pkgDir: string): string | null {
  try {
    return JSON.parse(readFileSync(resolve(pkgDir, "package.json"), "utf-8")).version ?? null;
  } catch {
    return null;
  }
}

/**
 * Pure path analysis: given the (symlink-resolved) path of the running binary, work out the
 * `volute` package dir and the npm global prefix that owns it. Returns isLinked=true when the
 * binary is not inside a `node_modules/volute`, meaning it's a source checkout / `npm link`.
 * Separated from IO so it can be unit-tested across platform layouts.
 */
export function analyzeInstallPath(realPath: string): {
  packageRoot: string | null;
  prefix: string | null;
  isLinked: boolean;
} {
  const marker = `${sep}node_modules${sep}volute${sep}`;
  const idx = realPath.indexOf(marker);
  if (idx === -1) return { packageRoot: null, prefix: null, isLinked: true };

  const packageRoot = `${realPath.slice(0, idx)}${sep}node_modules${sep}volute`;
  const nodeModulesRoot = dirname(packageRoot); // <...>/node_modules
  // Global installs live at <prefix>/lib/node_modules (unix) or <prefix>/node_modules (windows).
  const libDir = dirname(nodeModulesRoot);
  const prefix = basename(libDir) === "lib" ? dirname(libDir) : libDir;
  return { packageRoot, prefix, isLinked: false };
}

/**
 * Resolve where the `volute` binary that is actually on PATH lives, so updates can be
 * installed into the prefix that owns it rather than whatever prefix the ambient npm
 * happens to use. The two diverge under nvm/fnm/volta/Homebrew setups, which is the
 * usual cause of "update succeeded but nothing changed".
 */
export function resolveVoluteInstall(): VoluteInstall | null {
  let binPath: string;
  try {
    binPath = execFileSync("which", ["volute"], { encoding: "utf-8" }).trim();
  } catch {
    return null;
  }
  if (!binPath) return null;

  let realPath = binPath;
  try {
    realPath = realpathSync(binPath);
  } catch {}

  const { packageRoot, prefix, isLinked } = analyzeInstallPath(realPath);
  if (isLinked) {
    // Running from a source checkout or `npm link`.
    // Walk up from the binary to find its package.json for a best-effort version.
    let dir = dirname(realPath);
    let version: string | null = null;
    for (let i = 0; i < 4 && dir !== dirname(dir); i++) {
      version = readPackageVersion(dir);
      if (version) break;
      dir = dirname(dir);
    }
    return { binPath, realPath, packageRoot: null, prefix: null, version, isLinked: true };
  }

  return {
    binPath,
    realPath,
    packageRoot,
    prefix,
    version: packageRoot ? readPackageVersion(packageRoot) : null,
    isLinked: false,
  };
}

/** Run the resolved volute binary in a fresh process and return the version it reports. */
export async function getResolvedVersion(binPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFile(binPath, ["--version"], { timeout: 15_000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/** Synchronous cache-only check (ignores TTL). Returns null if no valid cache exists. */
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
