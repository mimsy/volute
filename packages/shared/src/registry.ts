import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findVariant, readVariants } from "./variants.js";

// In-memory registry cache for the daemon process.
// When active, reads come from memory and writes flush to disk.
// CLI processes (daemon not running) continue reading from file.
let registryCache: MindEntry[] | null = null;

export function initRegistryCache(): void {
  registryCache = readRegistryFromDisk();
}

export function getRegistryCache(): MindEntry[] | null {
  return registryCache;
}

function readRegistryFromDisk(): MindEntry[] {
  const registryPath = resolve(voluteHome(), "minds.json");
  if (!existsSync(registryPath)) return [];
  try {
    const entries = JSON.parse(readFileSync(registryPath, "utf-8")) as Array<
      Omit<MindEntry, "running"> & { running?: boolean }
    >;
    return entries.map((e) => ({
      ...e,
      running: e.running ?? false,
      stage: e.stage ?? "sprouted",
    }));
  } catch {
    return [];
  }
}

export function voluteHome(): string {
  if (process.env.VOLUTE_HOME) return process.env.VOLUTE_HOME;

  // When running from source (tsx), require explicit VOLUTE_HOME to prevent
  // tests from accidentally touching the real ~/.volute directory.
  // Built code (dist/) falls through to the homedir() default.
  const dir = dirname(fileURLToPath(import.meta.url));
  if (!dir.includes("/dist")) {
    throw new Error(
      "VOLUTE_HOME must be set when running from source. " +
        'For tests, run via "npm test" or add "--import ./test/setup.ts".',
    );
  }

  return resolve(homedir(), ".volute");
}

export type MindEntry = {
  name: string;
  port: number;
  created: string;
  running: boolean;
  stage?: "seed" | "sprouted";
  template?: string;
  templateHash?: string;
};

export function ensureVoluteHome() {
  const mindsBase = process.env.VOLUTE_MINDS_DIR ?? resolve(voluteHome(), "minds");
  mkdirSync(mindsBase, { recursive: true });
}

export function readRegistry(): MindEntry[] {
  if (registryCache) return registryCache;
  return readRegistryFromDisk();
}

export function writeRegistry(entries: MindEntry[]) {
  if (registryCache) registryCache = entries;
  ensureVoluteHome();
  const registryPath = resolve(voluteHome(), "minds.json");
  const tmpPath = `${registryPath}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(entries, null, 2)}\n`);
  renameSync(tmpPath, registryPath);
}

const MIND_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const MIND_NAME_MAX = 64;

export function validateMindName(name: string): string | null {
  if (!name) return "Mind name is required";
  if (name.length > MIND_NAME_MAX) return `Mind name must be at most ${MIND_NAME_MAX} characters`;
  if (!MIND_NAME_RE.test(name)) {
    return "Mind name must start with alphanumeric and contain only alphanumeric, dots, dashes, or underscores";
  }
  return null;
}

export function addMind(
  name: string,
  port: number,
  stage?: "seed" | "sprouted",
  template?: string,
) {
  const err = validateMindName(name);
  if (err) throw new Error(err);
  const entries = readRegistry();
  const filtered = entries.filter((e) => e.name !== name);
  filtered.push({ name, port, created: new Date().toISOString(), running: false, stage, template });
  writeRegistry(filtered);
}

export function removeMind(name: string) {
  const entries = readRegistry();
  writeRegistry(entries.filter((e) => e.name !== name));
}

export function setMindRunning(name: string, running: boolean) {
  const entries = readRegistry();
  const entry = entries.find((e) => e.name === name);
  if (entry) {
    entry.running = running;
    writeRegistry(entries);
  }
}

export function setMindStage(name: string, stage: "seed" | "sprouted") {
  const entries = readRegistry();
  const entry = entries.find((e) => e.name === name);
  if (entry) {
    entry.stage = stage;
    writeRegistry(entries);
  }
}

export function setMindTemplateHash(name: string, hash: string) {
  const entries = readRegistry();
  const entry = entries.find((e) => e.name === name);
  if (entry) {
    entry.templateHash = hash;
    writeRegistry(entries);
  }
}

export function findMind(name: string): MindEntry | undefined {
  return readRegistry().find((e) => e.name === name);
}

export function mindDir(name: string): string {
  if (process.env.VOLUTE_MINDS_DIR) {
    return resolve(process.env.VOLUTE_MINDS_DIR, name);
  }
  return resolve(voluteHome(), "minds", name);
}

export function stateDir(name: string): string {
  return resolve(voluteHome(), "state", name);
}

export function nextPort(): number {
  const entries = readRegistry();
  const usedPorts = new Set(entries.map((e) => e.port));
  // Also reserve ports used by variants
  for (const entry of entries) {
    for (const v of readVariants(entry.name)) {
      if (v.port) usedPorts.add(v.port);
    }
  }
  const basePort = parseInt(process.env.VOLUTE_BASE_PORT || "4100", 10);
  let port = basePort;
  while (usedPorts.has(port)) port++;
  if (port > 65535) throw new Error("No available ports — all ports 4100-65535 are allocated");
  return port;
}

/** Map a server bind hostname to the appropriate loopback for internal connections. */
export function daemonLoopback(): string {
  const host = process.env.VOLUTE_DAEMON_HOSTNAME || "127.0.0.1";
  if (host === "0.0.0.0") return "127.0.0.1";
  if (host === "::") return "[::1]";
  return host;
}

export function resolveMind(name: string): { entry: MindEntry; dir: string } {
  // Parse name@variant syntax
  const [baseName, variantName] = name.split("@", 2);

  const entry = findMind(baseName);
  if (!entry) {
    throw new Error(`Unknown mind: ${baseName}`);
  }
  const dir = mindDir(baseName);
  if (!existsSync(dir)) {
    throw new Error(`Mind directory missing: ${dir}`);
  }

  if (variantName) {
    const variant = findVariant(baseName, variantName);
    if (!variant) {
      throw new Error(`Unknown variant: ${variantName} (mind: ${baseName})`);
    }
    return { entry: { ...entry, port: variant.port }, dir: variant.path };
  }

  return { entry, dir };
}
