import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { eq, isNull } from "drizzle-orm";
import { getDb } from "./db.js";
import { minds } from "./schema.js";

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
export async function readRegistry(): Promise<MindEntry[]> {
  const db = await getDb();
  const rows = await db.select().from(minds).where(isNull(minds.parent));
  return (rows as unknown as RawMindRow[]).map(rowToEntry);
}

/** Read ALL minds (base + variants) from DB. */
export async function readAllMinds(): Promise<MindEntry[]> {
  const db = await getDb();
  const rows = await db.select().from(minds);
  return (rows as unknown as RawMindRow[]).map(rowToEntry);
}

const MIND_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const MIND_NAME_MAX = 64;

const RESERVED_NAMES = new Set(["volute", "system"]);

export function validateMindName(name: string): string | null {
  if (!name) return "Mind name is required";
  if (name.length > MIND_NAME_MAX) return `Mind name must be at most ${MIND_NAME_MAX} characters`;
  if (!MIND_NAME_RE.test(name)) {
    return "Mind name must start with alphanumeric and contain only alphanumeric, dots, dashes, or underscores";
  }
  if (RESERVED_NAMES.has(name.toLowerCase())) {
    return `"${name}" is a reserved name`;
  }
  return null;
}

export async function addMind(
  name: string,
  port: number,
  stage?: "seed" | "sprouted",
  template?: string,
) {
  const err = validateMindName(name);
  if (err) throw new Error(err);
  const db = await getDb();
  await db
    .insert(minds)
    .values({ name, port, stage: stage ?? null, template: template ?? null })
    .onConflictDoUpdate({
      target: minds.name,
      set: { port, stage: stage ?? null, template: template ?? null },
    });
}

export async function addVariant(
  name: string,
  parent: string,
  port: number,
  dir: string,
  branch: string,
) {
  const err = validateMindName(name);
  if (err) throw new Error(err);
  const db = await getDb();
  await db.insert(minds).values({ name, port, parent, dir, branch }).onConflictDoUpdate({
    target: minds.name,
    set: { port, parent, dir, branch },
  });
}

export async function removeMind(name: string) {
  const db = await getDb();
  await db.delete(minds).where(eq(minds.name, name));
}

export async function setMindRunning(name: string, running: boolean) {
  const db = await getDb();
  await db
    .update(minds)
    .set({ running: running ? 1 : 0 })
    .where(eq(minds.name, name));
}

export async function setMindStage(name: string, stage: "seed" | "sprouted") {
  const db = await getDb();
  await db.update(minds).set({ stage }).where(eq(minds.name, name));
}

export async function setMindTemplateHash(name: string, hash: string) {
  const db = await getDb();
  await db.update(minds).set({ template_hash: hash }).where(eq(minds.name, name));
}

export async function findMind(name: string): Promise<MindEntry | undefined> {
  const db = await getDb();
  const rows = await db.select().from(minds).where(eq(minds.name, name));
  if (rows.length === 0) return undefined;
  return rowToEntry(rows[0] as unknown as RawMindRow);
}

export async function findVariants(parent: string): Promise<MindEntry[]> {
  const db = await getDb();
  const rows = await db.select().from(minds).where(eq(minds.parent, parent));
  return (rows as unknown as RawMindRow[]).map(rowToEntry);
}

/** Get the base mind name for a given name. If it's a variant, returns its parent. */
export async function getBaseName(name: string): Promise<string> {
  const entry = await findMind(name);
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

export async function nextPort(): Promise<number> {
  const db = await getDb();
  const rows = await db.select({ port: minds.port }).from(minds);
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
