import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getRawDb } from "./db.js";

export type MindEntry = {
  name: string;
  port: number;
  created: string;
  running: boolean;
  stage?: "seed" | "sprouted";
  template?: string;
  templateHash?: string;
  parent?: string;
  dir?: string;
  branch?: string;
};

export function voluteHome(): string {
  if (process.env.VOLUTE_HOME) return process.env.VOLUTE_HOME;

  // When running from source (tsx), require explicit VOLUTE_HOME to prevent
  // tests from accidentally touching the real ~/.volute directory.
  // Built code (dist/) falls through to the homedir() default.
  const dir = dirname(fileURLToPath(import.meta.url));
  if (dir.endsWith("/src/lib")) {
    throw new Error(
      "VOLUTE_HOME must be set when running from source. " +
        'For tests, run via "npm test" or add "--import ./test/setup.ts".',
    );
  }

  return resolve(homedir(), ".volute");
}

/**
 * Per-user config directory (~/.volute/), independent of VOLUTE_HOME.
 * Used for user-specific state like login sessions and API keys that
 * shouldn't live in system directories (e.g. /var/lib/volute).
 */
export function voluteUserHome(): string {
  if (process.env.VOLUTE_USER_HOME) return process.env.VOLUTE_USER_HOME;
  return resolve(homedir(), ".volute");
}

export function voluteSystemDir(): string {
  return resolve(voluteHome(), "system");
}

export function ensureSystemDir(): void {
  mkdirSync(voluteSystemDir(), { recursive: true });
}

export function ensureVoluteHome() {
  const mindsBase = process.env.VOLUTE_MINDS_DIR ?? resolve(voluteHome(), "minds");
  mkdirSync(mindsBase, { recursive: true });
  ensureSystemDir();
}

type RawMindRow = {
  name: string;
  port: number;
  parent: string | null;
  dir: string | null;
  branch: string | null;
  stage: string | null;
  template: string | null;
  template_hash: string | null;
  running: number;
  created_at: string;
};

function rowToEntry(row: RawMindRow): MindEntry {
  return {
    name: row.name,
    port: row.port,
    created: row.created_at,
    running: row.running === 1,
    stage: (row.stage as MindEntry["stage"]) ?? (row.parent ? undefined : "sprouted"),
    template: row.template ?? undefined,
    templateHash: row.template_hash ?? undefined,
    parent: row.parent ?? undefined,
    dir: row.dir ?? undefined,
    branch: row.branch ?? undefined,
  };
}

/** Read base minds (no parent) from DB. */
export function readRegistry(): MindEntry[] {
  const db = getRawDb();
  const rows = db.prepare("SELECT * FROM minds WHERE parent IS NULL").all() as RawMindRow[];
  return rows.map(rowToEntry);
}

/** Read ALL minds (base + variants) from DB. */
export function readAllMinds(): MindEntry[] {
  const db = getRawDb();
  const rows = db.prepare("SELECT * FROM minds").all() as RawMindRow[];
  return rows.map(rowToEntry);
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
  const db = getRawDb();
  db.prepare(
    `INSERT INTO minds (name, port, stage, template) VALUES (?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET port=excluded.port, stage=excluded.stage, template=excluded.template`,
  ).run(name, port, stage ?? null, template ?? null);
}

export function addVariant(
  name: string,
  parent: string,
  port: number,
  dir: string,
  branch: string,
) {
  const err = validateMindName(name);
  if (err) throw new Error(err);
  const db = getRawDb();
  db.prepare(
    `INSERT INTO minds (name, port, parent, dir, branch) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET port=excluded.port, parent=excluded.parent, dir=excluded.dir, branch=excluded.branch`,
  ).run(name, port, parent, dir, branch);
}

export function removeMind(name: string) {
  const db = getRawDb();
  db.prepare("DELETE FROM minds WHERE name = ?").run(name);
}

export function setMindRunning(name: string, running: boolean) {
  const db = getRawDb();
  db.prepare("UPDATE minds SET running = ? WHERE name = ?").run(running ? 1 : 0, name);
}

export function setMindStage(name: string, stage: "seed" | "sprouted") {
  const db = getRawDb();
  db.prepare("UPDATE minds SET stage = ? WHERE name = ?").run(stage, name);
}

export function setMindTemplateHash(name: string, hash: string) {
  const db = getRawDb();
  db.prepare("UPDATE minds SET template_hash = ? WHERE name = ?").run(hash, name);
}

export function findMind(name: string): MindEntry | undefined {
  const db = getRawDb();
  const row = db.prepare("SELECT * FROM minds WHERE name = ?").get(name) as RawMindRow | undefined;
  return row ? rowToEntry(row) : undefined;
}

export function findVariants(parent: string): MindEntry[] {
  const db = getRawDb();
  const rows = db.prepare("SELECT * FROM minds WHERE parent = ?").all(parent) as RawMindRow[];
  return rows.map(rowToEntry);
}

/** Get the base mind name for a given name. If it's a variant, returns its parent. */
export function getBaseName(name: string): string {
  const entry = findMind(name);
  return entry?.parent ?? name;
}

export function mindDir(name: string): string {
  if (process.env.VOLUTE_MINDS_DIR) {
    return resolve(process.env.VOLUTE_MINDS_DIR, name);
  }
  return resolve(voluteHome(), "minds", name);
}

export function stateDir(name: string): string {
  return resolve(voluteSystemDir(), "state", name);
}

export function nextPort(): number {
  const db = getRawDb();
  const rows = db.prepare("SELECT port FROM minds").all() as Array<{ port: number }>;
  const usedPorts = new Set(rows.map((r) => r.port));
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

// --- Legacy JSON support (for migration) ---

export function readRegistryFromDisk(): Array<{
  name: string;
  port: number;
  created: string;
  running: boolean;
  stage?: string;
  template?: string;
  templateHash?: string;
}> {
  const registryPath = resolve(voluteSystemDir(), "minds.json");
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

// Backwards compatibility — these are no-ops now but kept for callsites that haven't been updated
export function initRegistryCache(): void {}
export function getRegistryCache(): MindEntry[] | null {
  try {
    return readRegistry();
  } catch {
    return null;
  }
}
export function writeRegistry(_entries: MindEntry[]) {
  // No-op — DB is the source of truth now
}
