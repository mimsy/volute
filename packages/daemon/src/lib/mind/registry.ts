import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
// Intentional import cycle with config/setup.ts (which imports voluteSystemDir
// from here): both modules export only hoisted function declarations and neither
// calls the other at module-evaluation time, so resolution is safe.
import { getSpiritName } from "../config/setup.js";
import { getDb } from "../db.js";
import {
  activity,
  channelGates,
  conversations,
  deliveryQueue,
  mindHistory,
  minds,
  summaries,
  systemEvents,
  turns,
  users,
} from "../schema.js";

export type MindType = "mind" | "spirit";

/**
 * True when a mind/user name is the system spirit's name (config
 * `setup.spiritName`, default "volute"). The spirit shares the system user
 * account (see auth.ts `getOrCreateSystemUser`), so this name is used
 * interchangeably as the mind name, the system user's username, and the
 * spirit's DM channel ("@<name>").
 */
export function isSpiritName(name: string): boolean {
  return name === getSpiritName();
}

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
  /** Why a variant was split off — set at split time, orients the variant and the UI. */
  purpose?: string;
  mindType: MindType;
  createdBy?: string;
};

export function voluteHome(): string {
  if (process.env.VOLUTE_HOME) return process.env.VOLUTE_HOME;

  // When running from source (tsx), require explicit VOLUTE_HOME to prevent
  // tests from accidentally touching the real ~/.volute directory.
  // Built code (dist/) is bundled to .js and falls through to the homedir()
  // default. Keying off the file extension (rather than a directory segment)
  // keeps this guard working even if the file moves within the source tree.
  if (fileURLToPath(import.meta.url).endsWith(".ts")) {
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
  purpose: string | null;
  template: string | null;
  template_hash: string | null;
  running: number;
  mind_type: string;
  created_by: string | null;
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
    purpose: row.purpose ?? undefined,
    mindType: (row.mind_type as MindType) ?? "mind",
    createdBy: row.created_by ?? undefined,
  };
}

/** Read base minds and spirits (no variants) from DB. */
export async function readRegistry(): Promise<MindEntry[]> {
  const db = await getDb();
  const rows = await db
    .select()
    .from(minds)
    .where(and(isNull(minds.parent), inArray(minds.mind_type, ["mind", "spirit"])));
  return (rows as unknown as RawMindRow[]).map(rowToEntry);
}

/**
 * Count minds that count toward the `maxMinds` cap: base minds only. Variants
 * (transient worktrees) and the spirit are excluded. `readRegistry` already
 * filters out variants (parent is null) and non-mind/spirit rows.
 */
export async function countCappedMinds(): Promise<number> {
  const entries = await readRegistry();
  return entries.filter((e) => e.mindType !== "spirit").length;
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
  // The spirit's (possibly host-chosen) name: addMind's upsert on minds.name
  // would otherwise clobber the spirit's registry row.
  if (isSpiritName(name)) {
    return `"${name}" is the spirit's name`;
  }
  return null;
}

/** Validate a host-chosen spirit name. Same shape rules as mind names; "volute" is allowed. */
export function validateSpiritName(name: string): string | null {
  if (!name) return "Spirit name is required";
  if (name.length > MIND_NAME_MAX) return `Spirit name must be at most ${MIND_NAME_MAX} characters`;
  if (!MIND_NAME_RE.test(name)) {
    return "Spirit name must start with alphanumeric and contain only alphanumeric, dots, dashes, or underscores";
  }
  if (name.toLowerCase() === "system") return `"${name}" is a reserved name`;
  return null;
}

export async function addMind(
  name: string,
  port: number,
  stage?: "seed" | "sprouted",
  template?: string,
  createdBy?: string,
) {
  const err = validateMindName(name);
  if (err) throw new Error(err);
  const db = await getDb();
  await db
    .insert(minds)
    .values({
      name,
      port,
      stage: stage ?? null,
      template: template ?? null,
      created_by: createdBy ?? null,
    })
    .onConflictDoUpdate({
      target: minds.name,
      set: {
        port,
        stage: stage ?? null,
        template: template ?? null,
        created_by: createdBy ?? null,
      },
    });
}

export async function addSpirit(name: string, port: number, template: string, dir: string) {
  const db = await getDb();
  await db
    .insert(minds)
    .values({
      name,
      port,
      template,
      dir,
      mind_type: "spirit",
      stage: "sprouted",
    })
    .onConflictDoUpdate({
      target: minds.name,
      set: { port, template, dir, mind_type: "spirit" },
    });
}

/** Read all spirits from DB. */
export async function readSpirits(): Promise<MindEntry[]> {
  const db = await getDb();
  const rows = await db.select().from(minds).where(eq(minds.mind_type, "spirit"));
  return (rows as unknown as RawMindRow[]).map(rowToEntry);
}

export async function addVariant(
  name: string,
  parent: string,
  port: number,
  dir: string,
  branch: string,
  purpose?: string,
) {
  const err = validateMindName(name);
  if (err) throw new Error(err);
  const db = await getDb();
  // On name conflict every field is overwritten, so an omitted purpose resets it to
  // null. The split route pre-checks name uniqueness (409), so in practice this update
  // path is only hit re-registering the same variant, where clobbering is intended.
  await db
    .insert(minds)
    .values({ name, port, parent, dir, branch, purpose: purpose ?? null })
    .onConflictDoUpdate({
      target: minds.name,
      set: { port, parent, dir, branch, purpose: purpose ?? null },
    });
}

export async function removeMind(name: string) {
  const db = await getDb();
  await db.delete(minds).where(eq(minds.name, name));
}

/**
 * Delete a mind's DB footprint outside the `minds` table: its user row (and,
 * via FK cascade, its channel memberships, read cursors, and login sessions),
 * the conversations it owns (cascading to their messages/channels/participants),
 * and the free-text-keyed rows that have no FK cascade (turns, history, activity,
 * summaries, notices, channel gates, delivery queue).
 *
 * Used when a variant is merged, deleted, or reconciled away — nothing else
 * references a gone variant, so leaving these rows behind just strands state
 * attributed to a mind that no longer exists (#444). Messages the mind sent into
 * shared channels stay as history (they belong to the base channel, not the
 * mind), but its membership in those channels is removed with the user row.
 */
export async function deleteMindDbFootprint(name: string): Promise<void> {
  const db = await getDb();

  // One transaction so cleanup is all-or-nothing — a partial purge would leave the
  // exact stranded state this is meant to remove.
  await db.transaction(async (tx) => {
    // Genuinely keyed by this (variant) name:
    // - the mind's user row and the conversations it owns (FK-cascade to their
    //   messages/channels/participants/reads), and its login sessions.
    // - activity: start/stop/active events are published under the raw name, so a
    //   variant accumulates its own rows.
    // - delivery_queue: `mind` is always the base name, but `target_mind` carries the
    //   variant name for a message routed to the variant — drop those stranded rows.
    const owner = await tx
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.username, name), eq(users.user_type, "mind")))
      .get();
    if (owner) {
      await tx.delete(conversations).where(eq(conversations.user_id, owner.id));
    }
    await tx.delete(users).where(and(eq(users.username, name), eq(users.user_type, "mind")));
    await tx.delete(activity).where(eq(activity.mind, name));
    await tx
      .delete(deliveryQueue)
      .where(or(eq(deliveryQueue.mind, name), eq(deliveryQueue.target_mind, name)));

    // Normally keyed by the BASE name: the delivery pipeline records these under
    // getBaseName() (handleMindEvent/recordInbound), so a live variant produces no
    // rows here and deleting by the variant name is a no-op for the base mind's data.
    // Kept as a defensive sweep of legacy `name@variant` rows that older flows, which
    // persisted under the delivered name, could have left behind.
    await tx.delete(turns).where(eq(turns.mind, name));
    await tx.delete(mindHistory).where(eq(mindHistory.mind, name));
    await tx.delete(summaries).where(eq(summaries.mind, name));
    await tx.delete(systemEvents).where(eq(systemEvents.mind, name));
    await tx.delete(channelGates).where(eq(channelGates.mind, name));
  });
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

export async function setMindTemplate(name: string, template: string) {
  const db = await getDb();
  await db.update(minds).set({ template }).where(eq(minds.name, name));
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

/** Resolve the actual directory for a mind, checking DB for custom dir (e.g. spirits). */
export async function resolveMindDir(name: string): Promise<string> {
  const entry = await findMind(name);
  return entry?.dir ?? mindDir(name);
}

export function stateDir(name: string): string {
  return resolve(voluteSystemDir(), "state", name);
}

/**
 * Per-mind temp directory (inside the mind's own project dir so it's covered by
 * the sandbox's allowRead/allowWrite and, under user isolation, chowned to the
 * mind). Used as the mind's TMPDIR so minds never share a writable /tmp.
 */
export function mindTmpDir(dir: string): string {
  return resolve(dir, ".mind", "tmp");
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
