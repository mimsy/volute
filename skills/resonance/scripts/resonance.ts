#!/usr/bin/env tsx

/**
 * resonance.ts — automatic recall over a mind's own memory files.
 *
 * Indexes the markdown under the configured memory dirs (full-text, and optionally
 * embeddings), keeps that index current incrementally, and — once per turn, from the
 * pre-prompt hook — quietly brings back the few excerpts the incoming message echoes.
 * Memories have strength: recalled ones strengthen, surfaced ones a little, and the
 * rest decay slowly toward a floor.
 *
 * Usage:
 *   resonance search "query" [--limit N] [--fts] [--vector]
 *   resonance recall <id> [id2 ...]      # strengthen memories that mattered
 *   resonance random [--limit N] [--min-strength F] [--max-strength F]
 *   resonance sync [--embed]             # catch the index up now (--embed: fill embeddings)
 *   resonance stats
 *   resonance search-hook                # internal: the per-turn pre-prompt hook
 */

import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const libsqlRequire = createRequire(import.meta.url);

// --- types ---

export type RecallMode = "auto" | "on-demand" | "off";

interface EmbeddingConfig {
  url: string;
  model: string;
  dimensions: number;
  apiKeyEnvVar: string;
}

export interface ResonanceConfig {
  recall: RecallMode;
  /** null = embeddings off (the default). No provider is assumed. */
  embedding: EmbeddingConfig | null;
  ingestion: {
    dirs: string[];
    files: string[];
    chunkSize: number;
    chunkOverlap: number;
    ignorePatterns: string[];
  };
  dynamics: {
    decayRate: number;
    minStrength: number;
    resonanceBoost: number;
    surfaceBoost: number;
  };
  /** Problems loadConfig worked around (e.g. a dropped invalid regex), for the mind to hear. */
  warnings?: string[];
}

export interface Chunk {
  content: string;
  sourceFile: string;
  sourceType: string;
  /** The heading this chunk sits under ("" for text before the first heading). */
  section: string;
  /** Which occurrence of that heading in the file (0 for the first). */
  sectionIndex: number;
  /** Sub-chunk index within the section, for sections longer than chunkSize. */
  chunkIndex: number;
  contentHash: string;
}

type SearchMode = "hybrid" | "fts" | "vector";

interface SearchResult {
  id: number;
  content: string;
  sourceFile: string;
  sourceType: string;
  section: string;
  similarity: number;
  weightedSimilarity: number;
  strength: number;
  recallCount: number;
  matchType: "vector" | "fts" | "both";
}

type Database = import("libsql").Database;

// --- config ---

const RECALL_MODES: RecallMode[] = ["auto", "on-demand", "off"];

function mindDirEnv(): string | undefined {
  return process.env.VOLUTE_MIND_DIR || undefined;
}

function getHomePath(): string {
  const mindDir = mindDirEnv();
  if (!mindDir) throw new Error("VOLUTE_MIND_DIR not set — are you running inside a mind?");
  return join(mindDir, "home");
}

/**
 * How recall behaves is a memory choice, not an engine setting, so it lives with the
 * mind's other memory options: `memory.recall` in `.config/config.json` (default "auto").
 */
export function readRecallMode(): RecallMode {
  const mindDir = mindDirEnv();
  if (!mindDir) return "auto";
  const path = join(mindDir, "home", ".config", "config.json");
  if (!existsSync(path)) return "auto";
  const recall = JSON.parse(readFileSync(path, "utf-8"))?.memory?.recall ?? "auto";
  if (!RECALL_MODES.includes(recall)) {
    throw new Error(
      `Invalid config.json: "memory.recall" must be one of ${RECALL_MODES.join(", ")}`,
    );
  }
  return recall;
}

/** Engine settings from `.config/resonance.json` (optional) over the built-in defaults. */
export function loadConfig(): ResonanceConfig {
  const defaultConfigPath = resolve(
    fileURLToPath(new URL(".", import.meta.url)),
    "..",
    "assets",
    "default-config.json",
  );
  const defaults: Omit<ResonanceConfig, "recall"> = JSON.parse(
    readFileSync(defaultConfigPath, "utf-8"),
  );
  const recall = readRecallMode();

  const mindDir = mindDirEnv();
  const overridePath = mindDir && join(mindDir, "home", ".config", "resonance.json");
  if (!overridePath || !existsSync(overridePath)) return { ...defaults, recall };

  const override = JSON.parse(readFileSync(overridePath, "utf-8"));
  if (typeof override !== "object" || override === null || Array.isArray(override)) {
    throw new Error("Invalid resonance.json: must be a JSON object");
  }
  for (const key of ["ingestion", "dynamics"] as const) {
    if (key in override && (typeof override[key] !== "object" || override[key] === null)) {
      throw new Error(`Invalid resonance.json: "${key}" must be an object`);
    }
  }
  let embedding: EmbeddingConfig | null = null;
  if (override.embedding != null) {
    const e = override.embedding;
    if (
      typeof e !== "object" ||
      typeof e.url !== "string" ||
      typeof e.model !== "string" ||
      typeof e.apiKeyEnvVar !== "string" ||
      !Number.isInteger(e.dimensions) ||
      e.dimensions < 1
    ) {
      throw new Error(
        'Invalid resonance.json: "embedding" needs url, model, apiKeyEnvVar (strings) and dimensions (a positive integer), or null to turn embeddings off',
      );
    }
    embedding = {
      url: e.url,
      model: e.model,
      dimensions: e.dimensions,
      apiKeyEnvVar: e.apiKeyEnvVar,
    };
  }
  const config: ResonanceConfig = {
    recall,
    embedding,
    ingestion: { ...defaults.ingestion, ...override.ingestion },
    dynamics: { ...defaults.dynamics, ...override.dynamics },
  };
  validateConfig(config);
  return config;
}

/**
 * Refuse settings that would make resonance misbehave rather than merely look odd — a
 * chunkOverlap that isn't below chunkSize never advances the chunker, which would spin
 * away the whole pre-prompt budget every turn. An ignore pattern that isn't a valid
 * regex is dropped with a warning instead, so one typo doesn't stop recall.
 */
export function validateConfig(config: ResonanceConfig): void {
  const bad = (msg: string) => {
    throw new Error(`Invalid resonance.json: ${msg}`);
  };
  const { ingestion, dynamics } = config;
  const isStrings = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === "string");
  for (const key of ["dirs", "files", "ignorePatterns"] as const) {
    if (!isStrings(ingestion[key])) bad(`"ingestion.${key}" must be a list of strings`);
  }
  if (!Number.isInteger(ingestion.chunkSize) || ingestion.chunkSize < 1) {
    bad('"ingestion.chunkSize" must be a whole number of at least 1');
  }
  if (
    !Number.isInteger(ingestion.chunkOverlap) ||
    ingestion.chunkOverlap < 0 ||
    ingestion.chunkOverlap >= ingestion.chunkSize
  ) {
    bad('"ingestion.chunkOverlap" must be a whole number from 0 up to (not including) chunkSize');
  }
  for (const [key, value] of Object.entries(dynamics)) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      bad(`"dynamics.${key}" must be a number`);
    }
  }

  const warnings: string[] = [];
  ingestion.ignorePatterns = ingestion.ignorePatterns.filter((p) => {
    try {
      new RegExp(p, "m");
      return true;
    } catch {
      warnings.push(`ignored an invalid ignorePatterns entry: ${p}`);
      return false;
    }
  });
  if (warnings.length > 0) config.warnings = warnings;
}

// --- timestamps ---

/** "YYYY-MM-DD HH:MM:SS" in UTC — the same zone-less shape SQLite's datetime('now') writes. */
export function toDbTimestamp(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

/**
 * Parse a zone-less DB timestamp as UTC. `new Date("2026-01-01 10:00:00")` reads it as
 * *local* time, which shifted every decay computation by the host's UTC offset.
 */
export function parseDbTimestamp(ts: string): number {
  const iso = ts.includes("T") ? ts : ts.replace(" ", "T");
  return new Date(/[Zz]|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : `${iso}Z`).getTime();
}

// --- database ---

/** Bumped when the schema changes shape. An older DB is rebuilt from the files. */
const SCHEMA_VERSION = 2;

function getDbPath(): string {
  const mindDir = mindDirEnv();
  if (!mindDir) throw new Error("VOLUTE_MIND_DIR not set — are you running inside a mind?");
  const dir = join(mindDir, ".mind");
  mkdirSync(dir, { recursive: true });
  return join(dir, "resonance.db");
}

function transaction<T>(db: Database, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export function initDb(dbPath: string): Database {
  const Database = libsqlRequire("libsql");
  const db = new Database(dbPath) as Database;
  // The hook and a command the mind runs can overlap; wait for the lock, don't fail.
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA journal_mode=WAL");

  const version = () =>
    (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (version() === SCHEMA_VERSION) return db;

  transaction(db, () => {
    if (version() === SCHEMA_VERSION) return; // another process got here first
    // The text is derived from the mind's files and is rebuilt from them. What isn't
    // derivable — how strong each memory has grown, how often it was recalled — is
    // carried across by (path, heading) and re-attached as the files are re-indexed.
    const carried = readCarriedHistory(db, join(dirname(dirname(dbPath)), "home"));
    for (const t of [
      "memories_ai",
      "memories_ad",
      "memories_au",
      "embeddings_ad",
      "embeddings_au",
    ]) {
      db.exec(`DROP TRIGGER IF EXISTS ${t}`);
    }
    for (const t of [
      "memories_fts",
      "embeddings",
      "memories",
      "indexed_files",
      "surfaced",
      "meta",
      "carried",
    ]) {
      db.exec(`DROP TABLE IF EXISTS ${t}`);
    }
    db.exec(`
      CREATE TABLE memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content TEXT NOT NULL,
        source_file TEXT NOT NULL,
        source_type TEXT NOT NULL,
        section TEXT NOT NULL DEFAULT '',
        section_index INTEGER NOT NULL DEFAULT 0,
        chunk_index INTEGER NOT NULL DEFAULT 0,
        content_hash TEXT NOT NULL,
        strength REAL NOT NULL DEFAULT 1.0,
        recall_count INTEGER NOT NULL DEFAULT 0,
        surfaced_count INTEGER NOT NULL DEFAULT 0,
        last_recalled TEXT,
        last_decayed TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (source_file, content_hash)
      )
    `);
    db.exec("CREATE INDEX idx_memories_strength ON memories(strength)");
    // Only the text is indexed: a file path is not something a memory is *about*.
    // Porter stemming lets "lighthouse" find "lighthouses".
    db.exec(`
      CREATE VIRTUAL TABLE memories_fts USING fts5(
        content, content='memories', content_rowid='id', tokenize='porter unicode61'
      )
    `);
    db.exec(`
      CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
      END
    `);
    db.exec(`
      CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.id, old.content);
      END
    `);
    // OF content: strength/recall updates happen every turn and must not re-index.
    db.exec(`
      CREATE TRIGGER memories_au AFTER UPDATE OF content ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.id, old.content);
        INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
      END
    `);
    // One row per indexed source. `kind` separates files on disk (swept when they
    // disappear) from any non-file source added later.
    db.exec(`
      CREATE TABLE indexed_files (
        path TEXT PRIMARY KEY,
        kind TEXT NOT NULL DEFAULT 'file',
        mtime_ms REAL NOT NULL,
        size INTEGER NOT NULL
      )
    `);
    db.exec(`
      CREATE TABLE surfaced (
        session TEXT NOT NULL,
        memory_id INTEGER NOT NULL,
        surfaced_at TEXT NOT NULL,
        PRIMARY KEY (session, memory_id)
      )
    `);
    db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    // History from an older layout, waiting for its file to be re-indexed.
    db.exec(`
      CREATE TABLE carried (
        path TEXT NOT NULL,
        section TEXT NOT NULL,
        strength REAL NOT NULL,
        recall_count INTEGER NOT NULL,
        surfaced_count INTEGER NOT NULL,
        last_recalled TEXT,
        last_decayed TEXT,
        PRIMARY KEY (path, section)
      )
    `);
    const keep = db.prepare(
      "INSERT OR REPLACE INTO carried (path, section, strength, recall_count, surfaced_count, last_recalled, last_decayed) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    for (const c of carried) {
      keep.run(
        c.path,
        c.section,
        c.strength,
        c.recall_count,
        c.surfaced_count,
        c.last_recalled,
        c.last_decayed,
      );
    }
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  });
  return db;
}

interface CarriedHistory {
  path: string;
  section: string;
  strength: number;
  recall_count: number;
  surfaced_count: number;
  last_recalled: string | null;
  last_decayed: string | null;
}

/**
 * The per-memory history in an older-layout DB, keyed by (path relative to home/,
 * heading). Where a heading held several chunks, the strongest and most-recalled wins.
 * The first layout stored absolute paths and kept the heading in a `metadata` JSON column.
 */
function readCarriedHistory(db: Database, home: string): CarriedHistory[] {
  const cols = new Set(
    (db.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>).map((c) => c.name),
  );
  if (!cols.has("strength") || !cols.has("source_file")) return [];
  const rows = db.prepare("SELECT * FROM memories").all() as Array<Record<string, any>>;
  const toRel = (p: string) => {
    if (p.startsWith(`${home}/`)) return p.slice(home.length + 1);
    const i = p.lastIndexOf("/home/");
    return i >= 0 ? p.slice(i + "/home/".length) : p;
  };
  const byKey = new Map<string, CarriedHistory>();
  for (const r of rows) {
    if (typeof r.source_file !== "string") continue;
    let section = typeof r.section === "string" ? r.section : "";
    if (!cols.has("section") && typeof r.metadata === "string") {
      try {
        section = JSON.parse(r.metadata)?.section ?? "";
      } catch {
        // unreadable metadata — treat as the preamble
      }
    }
    const path = toRel(r.source_file);
    const key = `${path}\u0000${section}`;
    const prev = byKey.get(key);
    const next: CarriedHistory = {
      path,
      section,
      strength: Math.max(prev?.strength ?? 0, Number(r.strength) || 0),
      recall_count: Math.max(prev?.recall_count ?? 0, Number(r.recall_count) || 0),
      surfaced_count: Math.max(prev?.surfaced_count ?? 0, Number(r.surfaced_count) || 0),
      last_recalled: [prev?.last_recalled, r.last_recalled].filter(Boolean).sort().pop() ?? null,
      last_decayed: [prev?.last_decayed, r.last_decayed].filter(Boolean).sort().pop() ?? null,
    };
    byKey.set(key, next);
  }
  return [...byKey.values()];
}

function getMeta(db: Database, key: string): string | null {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

function setMeta(db: Database, key: string, value: string): void {
  db.prepare(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

function hasEmbeddingsTable(db: Database): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='embeddings'").get();
}

/**
 * Make the embeddings table match the configured model and dimensions. Vectors from
 * different models (or sizes) aren't comparable, so a change drops them all; the next
 * `resonance sync --embed` refills them. Embeddings live in their own table so this
 * never touches a memory's text, strength or history.
 */
export function ensureEmbeddingSchema(db: Database, embedding: EmbeddingConfig | null): void {
  if (!embedding) return;
  const want = `${embedding.model}|${embedding.dimensions}`;
  if (hasEmbeddingsTable(db) && getMeta(db, "embedding") === want) return;
  transaction(db, () => {
    db.exec("DROP TRIGGER IF EXISTS embeddings_ad");
    db.exec("DROP TRIGGER IF EXISTS embeddings_au");
    db.exec("DROP TABLE IF EXISTS embeddings");
    db.exec(
      `CREATE TABLE embeddings (memory_id INTEGER PRIMARY KEY, embedding F32_BLOB(${embedding.dimensions}) NOT NULL)`,
    );
    db.exec(`
      CREATE TRIGGER embeddings_ad AFTER DELETE ON memories BEGIN
        DELETE FROM embeddings WHERE memory_id = old.id;
      END
    `);
    // An edited memory keeps its strength (see syncDocument) but its old vector is stale.
    db.exec(`
      CREATE TRIGGER embeddings_au AFTER UPDATE OF content ON memories BEGIN
        DELETE FROM embeddings WHERE memory_id = old.id;
      END
    `);
    setMeta(db, "embedding", want);
  });
}

function openDb(config: ResonanceConfig): Database {
  const db = initDb(getDbPath());
  ensureEmbeddingSchema(db, config.embedding);
  return db;
}

// --- embedding ---

function getApiKey(config: ResonanceConfig): string | null {
  if (!config.embedding) return null;
  return process.env[config.embedding.apiKeyEnvVar] || null;
}

async function embed(
  texts: string[],
  apiKey: string,
  embedding: EmbeddingConfig,
): Promise<number[][]> {
  const resp = await fetch(embedding.url, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: embedding.model, input: texts }),
  });
  if (!resp.ok) {
    throw new Error(`Embedding API error ${resp.status}: ${await resp.text()}`);
  }
  const data = (await resp.json()) as { data: Array<{ index: number; embedding: number[] }> };
  const vectors = data.data.sort((a, b) => a.index - b.index).map((e) => e.embedding);
  for (const v of vectors) {
    if (v.length !== embedding.dimensions) {
      throw new Error(
        `the embedding model returned ${v.length} dimensions but resonance.json says ${embedding.dimensions} — set "dimensions" to ${v.length}`,
      );
    }
  }
  return vectors;
}

// --- chunking ---

/** Source type from a path relative to home/. */
export function detectSourceType(relPath: string): string {
  const p = relPath.toLowerCase();
  if (p === "memory.md") return "memory";
  if (p.startsWith("memory/journal/")) return "journal";
  if (p.startsWith("memory/dreams/")) return "dream";
  if (p.startsWith("memory/topics/")) return "topic";
  return "other";
}

export function isMostlyIgnored(text: string, patterns: RegExp[]): boolean {
  if (patterns.length === 0) return false;
  const lines = text.trim().split("\n");
  if (lines.length === 0) return true;

  let ignoredLines = 0;
  let contentLines = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (patterns.some((p) => p.test(trimmed))) {
      ignoredLines++;
    } else {
      contentLines++;
    }
  }
  const total = ignoredLines + contentLines;
  if (total === 0) return true;
  return ignoredLines / total > 0.5;
}

export function stripIgnoredLines(text: string, patterns: RegExp[]): string {
  if (patterns.length === 0) return text;
  return text
    .split("\n")
    .filter((line) => !patterns.some((p) => p.test(line.trim())))
    .join("\n")
    .trim();
}

export function chunkByWords(
  text: string,
  sourceFile: string,
  sourceType: string,
  chunkSize: number,
  chunkOverlap: number,
): Chunk[] {
  const base = { sourceFile, sourceType, section: "", sectionIndex: 0, contentHash: "" };
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= chunkSize) return [{ ...base, content: text, chunkIndex: 0 }];

  const chunks: Chunk[] = [];
  let start = 0;
  while (start < words.length) {
    const end = Math.min(start + chunkSize, words.length);
    chunks.push({ ...base, content: words.slice(start, end).join(" "), chunkIndex: chunks.length });
    if (end >= words.length) break;
    start += Math.max(1, chunkSize - chunkOverlap);
  }
  return chunks;
}

export function chunkBySections(
  text: string,
  sourceFile: string,
  sourceType: string,
  config: ResonanceConfig,
  ignoreRe: RegExp[],
): Chunk[] {
  const sections = text.split(/^(#{1,6}\s+.+)$/m);
  const chunks: Chunk[] = [];
  const seen = new Map<string, number>();
  let currentHeader = "";

  for (let i = 0; i < sections.length; i++) {
    let part = sections[i].trim();
    if (/^#{1,6}\s+/.test(part)) {
      currentHeader = part;
      continue;
    }
    if (!part) continue;

    if (ignoreRe.length > 0) {
      part = stripIgnoredLines(part, ignoreRe);
      if (!part || part.split(/\s+/).length < 10) continue;
    }

    const sectionText = currentHeader ? `${currentHeader}\n\n${part}` : part;
    const words = sectionText.split(/\s+/).filter(Boolean);
    if (words.length < 15) continue;

    const sectionIndex = seen.get(currentHeader) ?? 0;
    seen.set(currentHeader, sectionIndex + 1);

    for (const sc of chunkByWords(
      sectionText,
      sourceFile,
      sourceType,
      config.ingestion.chunkSize,
      config.ingestion.chunkOverlap,
    )) {
      chunks.push({ ...sc, section: currentHeader, sectionIndex });
    }
  }
  return chunks;
}

export function chunkText(text: string, sourceFile: string, config: ResonanceConfig): Chunk[] {
  text = text.trim();
  if (!text) return [];

  const sourceType = detectSourceType(sourceFile);
  const ignoreRe = config.ingestion.ignorePatterns.map((p) => new RegExp(p, "m"));

  let chunks: Chunk[];
  if (/(^|\n)#{1,6}\s+/.test(text)) {
    chunks = chunkBySections(text, sourceFile, sourceType, config, ignoreRe);
  } else {
    const words = text.split(/\s+/).filter(Boolean);
    if (words.length < 15) return [];
    chunks = chunkByWords(
      text,
      sourceFile,
      sourceType,
      config.ingestion.chunkSize,
      config.ingestion.chunkOverlap,
    );
  }
  for (const c of chunks) c.contentHash = hashContent(c.content);
  return chunks;
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

// --- indexing ---

interface MemoryRow {
  id: number;
  content_hash: string;
  section: string;
  section_index: number;
  chunk_index: number;
}

/**
 * Bring the stored chunks for one source in line with its current text.
 *
 * Unchanged chunks are kept as they are. A chunk whose text changed but still sits at
 * the same place — same heading, same occurrence of it, same sub-chunk — is updated in
 * place, so editing a section keeps its id, strength and recall history. Anything else
 * is inserted, and chunks that no longer exist are removed, all in one transaction.
 *
 * `relPath` is a path relative to home/ (or, for a non-file source, any stable key).
 */
export function syncDocument(
  db: Database,
  relPath: string,
  sourceType: string,
  text: string,
  config: ResonanceConfig,
): { added: number; updated: number; removed: number } {
  const chunks = chunkText(text, relPath, config);
  const posKey = (section: string, sectionIndex: number, chunkIndex: number) =>
    `${section}\u0000${sectionIndex}\u0000${chunkIndex}`;

  return transaction(db, () => {
    const existing = db
      .prepare(
        "SELECT id, content_hash, section, section_index, chunk_index FROM memories WHERE source_file = ?",
      )
      .all(relPath) as MemoryRow[];
    const unclaimed = new Map(existing.map((r) => [r.id, r]));
    const byHash = new Map(existing.map((r) => [r.content_hash, r]));

    const setPosition = db.prepare(
      "UPDATE memories SET section = ?, section_index = ?, chunk_index = ?, source_type = ? WHERE id = ?",
    );
    const rewrite = db.prepare(
      "UPDATE memories SET content = ?, content_hash = ?, section = ?, section_index = ?, chunk_index = ?, source_type = ? WHERE id = ?",
    );
    const insert = db.prepare(
      `INSERT OR IGNORE INTO memories
         (content, source_file, source_type, section, section_index, chunk_index, content_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );

    const applyCarried = db.prepare(
      `UPDATE memories SET
         strength = c.strength, recall_count = c.recall_count, surfaced_count = c.surfaced_count,
         last_recalled = c.last_recalled, last_decayed = c.last_decayed
       FROM (SELECT * FROM carried WHERE path = ? AND section = ?) AS c
       WHERE memories.id = ?`,
    );

    // Pass 1: identical text keeps its row outright.
    const pending: Chunk[] = [];
    const placed = new Set<string>();
    for (const c of chunks) {
      const row = byHash.get(c.contentHash);
      if (row && unclaimed.has(row.id)) {
        unclaimed.delete(row.id);
        placed.add(c.contentHash);
        setPosition.run(c.section, c.sectionIndex, c.chunkIndex, sourceType, row.id);
      } else if (!row) {
        pending.push(c);
      }
    }

    // Pass 2: edited text inherits the row that held its position.
    const byPos = new Map<string, MemoryRow>();
    for (const r of unclaimed.values()) {
      byPos.set(posKey(r.section, r.section_index, r.chunk_index), r);
    }
    let added = 0;
    let updated = 0;
    for (const c of pending) {
      // The same text twice in one file is stored once.
      if (placed.has(c.contentHash)) continue;
      placed.add(c.contentHash);
      const row = byPos.get(posKey(c.section, c.sectionIndex, c.chunkIndex));
      if (row && unclaimed.has(row.id)) {
        unclaimed.delete(row.id);
        rewrite.run(
          c.content,
          c.contentHash,
          c.section,
          c.sectionIndex,
          c.chunkIndex,
          sourceType,
          row.id,
        );
        updated++;
      } else {
        const r = insert.run(
          c.content,
          relPath,
          sourceType,
          c.section,
          c.sectionIndex,
          c.chunkIndex,
          c.contentHash,
        );
        added += r.changes;
        if (r.changes > 0) {
          applyCarried.run(relPath, c.section, r.lastInsertRowid);
        }
      }
    }
    db.prepare("DELETE FROM carried WHERE path = ?").run(relPath);

    const del = db.prepare("DELETE FROM memories WHERE id = ?");
    for (const id of unclaimed.keys()) del.run(id);
    return { added, updated, removed: unclaimed.size };
  });
}

function toRelPath(home: string, abs: string): string {
  return relative(home, abs).split(sep).join("/");
}

/** Every markdown file the config points at, as paths relative to home/. */
function listSourceFiles(home: string, config: ResonanceConfig): Map<string, string> {
  const files = new Map<string, string>(); // rel -> abs
  const addIfFile = (abs: string) => {
    try {
      if (lstatSync(abs).isFile()) files.set(toRelPath(home, abs), abs);
    } catch {
      // missing — nothing to index
    }
  };
  for (const f of config.ingestion.files) addIfFile(join(home, f));

  const walk = (dir: string) => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // a configured dir that doesn't exist (yet) is not an error
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const abs = join(dir, e.name);
      // Dirent types come from lstat: symlinks are neither, so they're never followed.
      if (e.isDirectory()) walk(abs);
      else if (e.isFile() && e.name.endsWith(".md")) files.set(toRelPath(home, abs), abs);
    }
  };
  for (const d of config.ingestion.dirs) walk(join(home, d));
  return files;
}

export interface SyncResult {
  indexed: number;
  removed: number;
  /** Changed files left for a later sync because of the per-call cap. */
  pending: number;
}

/**
 * Incremental sync: stat every configured file, re-chunk only those whose mtime or size
 * changed (newest first, at most `maxFiles` and roughly `maxMs` per call so a backlog
 * catches up over several turns), and drop everything from files that are gone. Full-text only — embeddings are
 * filled separately by `sync --embed`, never on the per-turn path.
 */
export function syncFiles(
  db: Database,
  config: ResonanceConfig,
  maxFiles = Infinity,
  maxMs = Infinity,
): SyncResult {
  const started = Date.now();
  const home = getHomePath();
  const current = listSourceFiles(home, config);

  const known = new Map(
    (
      db
        .prepare("SELECT path, mtime_ms, size FROM indexed_files WHERE kind = 'file'")
        .all() as Array<{
        path: string;
        mtime_ms: number;
        size: number;
      }>
    ).map((r) => [r.path, r]),
  );

  let removed = 0;
  for (const path of known.keys()) {
    if (current.has(path)) continue;
    transaction(db, () => {
      db.prepare("DELETE FROM memories WHERE source_file = ?").run(path);
      db.prepare("DELETE FROM indexed_files WHERE path = ?").run(path);
    });
    removed++;
  }

  const changed: Array<{ rel: string; abs: string; mtimeMs: number; size: number }> = [];
  for (const [rel, abs] of current) {
    let st: import("node:fs").Stats;
    try {
      st = lstatSync(abs);
    } catch {
      continue;
    }
    const k = known.get(rel);
    if (k && k.mtime_ms === st.mtimeMs && k.size === st.size) continue;
    changed.push({ rel, abs, mtimeMs: st.mtimeMs, size: st.size });
  }
  changed.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const batch = changed.slice(0, maxFiles);
  const upsert = db.prepare(
    `INSERT INTO indexed_files (path, kind, mtime_ms, size) VALUES (?, 'file', ?, ?)
     ON CONFLICT(path) DO UPDATE SET mtime_ms = excluded.mtime_ms, size = excluded.size`,
  );
  let indexed = 0;
  let attempted = 0;
  for (const f of batch) {
    // Always make some progress, then stop once the time budget is spent.
    if (attempted > 0 && Date.now() - started >= maxMs) break;
    attempted++;
    let text: string;
    try {
      text = readFileSync(f.abs, "utf-8");
    } catch {
      continue;
    }
    syncDocument(db, f.rel, detectSourceType(f.rel), text, config);
    upsert.run(f.rel, f.mtimeMs, f.size);
    indexed++;
  }
  return { indexed, removed, pending: changed.length - attempted };
}

async function embedMissing(db: Database, config: ResonanceConfig): Promise<number> {
  const embedding = config.embedding;
  if (!embedding) {
    throw new Error(
      'embeddings are off. To turn them on, add an "embedding" section to .config/resonance.json ' +
        "with url, model, dimensions and apiKeyEnvVar for an OpenAI-compatible embeddings endpoint.",
    );
  }
  const apiKey = getApiKey(config);
  if (!apiKey) {
    throw new Error(
      `${embedding.apiKeyEnvVar} is not set (volute env set ${embedding.apiKeyEnvVar} <key>)`,
    );
  }
  const rows = db
    .prepare(
      `SELECT m.id, m.content FROM memories m
       LEFT JOIN embeddings e ON e.memory_id = m.id WHERE e.memory_id IS NULL`,
    )
    .all() as Array<{ id: number; content: string }>;
  const insert = db.prepare(
    "INSERT OR REPLACE INTO embeddings (memory_id, embedding) VALUES (?, vector(?))",
  );
  let done = 0;
  const batchSize = 20;
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const vectors = await embed(
      batch.map((r) => r.content.slice(0, 8000)),
      apiKey,
      embedding,
    );
    transaction(db, () => {
      for (let j = 0; j < batch.length; j++) {
        insert.run(batch[j].id, JSON.stringify(vectors[j]));
      }
    });
    done += batch.length;
  }
  return done;
}

// --- decay ---

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Decay every memory by `decayRate` per day since it was last touched — the latest of
 * its creation, its last decay and its last recall, so a recall restarts the clock.
 * Fractional days count, so nothing is lost between runs.
 */
export function runDecay(
  db: Database,
  config: ResonanceConfig,
  now = new Date(),
): { decayed: number; total: number } {
  const nowTs = toDbTimestamp(now);
  const update = db.prepare("UPDATE memories SET strength = ?, last_decayed = ? WHERE id = ?");
  let decayed = 0;
  let total = 0;
  // Read inside the write transaction, so a concurrent recall can't be overwritten with
  // a strength computed from before it.
  transaction(db, () => {
    const rows = db
      .prepare("SELECT id, strength, last_recalled, last_decayed, created_at FROM memories")
      .all() as Array<{
      id: number;
      strength: number;
      last_recalled: string | null;
      last_decayed: string | null;
      created_at: string;
    }>;
    total = rows.length;
    for (const row of rows) {
      const since = Math.max(
        ...[row.created_at, row.last_decayed, row.last_recalled]
          .filter((t): t is string => !!t)
          .map(parseDbTimestamp)
          .filter((t) => !Number.isNaN(t)),
      );
      if (!Number.isFinite(since)) continue;
      const days = (now.getTime() - since) / DAY_MS;
      if (days <= 0) continue;
      const next = Math.max(
        config.dynamics.minStrength,
        row.strength - config.dynamics.decayRate * days,
      );
      if (next === row.strength) continue;
      update.run(next, nowTs, row.id);
      decayed++;
    }
  });
  return { decayed, total };
}

/**
 * Decay lazily: at most once a day, whenever resonance next runs. There's no schedule to
 * set up or lose. The first run only starts the clock.
 */
export function maybeDecay(db: Database, config: ResonanceConfig, now = new Date()) {
  const last = getMeta(db, "last_decay_at");
  if (last && now.getTime() - parseDbTimestamp(last) < DAY_MS) return null;
  const result = last ? runDecay(db, config, now) : null;
  setMeta(db, "last_decay_at", toDbTimestamp(now));
  db.prepare("DELETE FROM surfaced WHERE surfaced_at < ?").run(
    toDbTimestamp(new Date(now.getTime() - 7 * DAY_MS)),
  );
  return result;
}

// --- query text ---

// Common English function words: they match everything and so mean nothing here.
const STOPWORDS = new Set(
  `about above after again against all also and any are aren because been before being below
  between both but can cannot could couldn did didn does doesn doing don down during each few for
  from further had hadn has hasn have haven having her here hers herself him himself his how into
  isn its itself just let lets like made make many may might more most much must mustn myself
  need nor not now off once only other ought our ours ourselves out over own really same she
  should shouldn some still such than that thats the their theirs them themselves then there these
  they this those through too under until upon very want was wasn were weren what when where which
  while who whom why will with won would wouldn yes yet you your yours yourself yourselves im ive
  youre its thing things okay going get got one two well even back way think know see say said
  hey hello thanks thank great good nice lol sure maybe something anything everything today
  tonight tomorrow yesterday morning evening night day days time http https www com`
    .split(/\s+/)
    .filter(Boolean),
);

/** Lowercased word tokens, accents folded — the words FTS5's unicode61 tokenizer sees. */
export function tokenize(text: string): string[] {
  return (
    text
      .normalize("NFKD")
      .replace(/\p{M}+/gu, "")
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? []
  );
}

const EVENT_HEADER = /^=== System event: .* ===$/;
// A message prefix line: `[Volute: alice in DM — 2026-09-23 10:00]` (or just `— 10:00]`).
const MESSAGE_PREFIX = /^\[[^\]\n]+ — (\d{4}-\d{2}-\d{2} )?\d{2}:\d{2}\]$/;

// Bracketed framing the router and prefixer add around what was said: participant and
// channel cards, batch headers, session instructions. Any of them may span lines.
const CARD_START = /^\[(Participants:|#|Batch:|Session instructions:)/;

const bracketDepth = (line: string) =>
  (line.match(/\[/g)?.length ?? 0) - (line.match(/\]/g)?.length ?? 0);

/**
 * The words a person (or mind) actually said this turn. Drops message prefix lines, the
 * cards and headers that ride along with them, typing notes, and every system-event
 * block — a heartbeat or notice is the environment speaking, and recall keyed on it
 * would surface the same memories every hour.
 */
export function cleanPrompt(prompt: string): string {
  const kept: string[] = [];
  let inEvent = false;
  // Open-bracket depth of the card being skipped. Counted, not "ends with ]", because a
  // participant line like `alice (Alice) [human]` ends with a bracket of its own.
  let cardDepth = 0;
  for (const raw of prompt.split("\n")) {
    const line = raw.trim();
    // A blank line or the next message prefix ends a card whatever its brackets say,
    // so one unmatched "[" can't swallow the rest of the prompt.
    if (cardDepth > 0 && (line === "" || MESSAGE_PREFIX.test(line))) cardDepth = 0;
    if (cardDepth > 0) {
      cardDepth += bracketDepth(line);
      continue;
    }
    if (EVENT_HEADER.test(line)) {
      inEvent = true;
      continue;
    }
    if (MESSAGE_PREFIX.test(line)) {
      inEvent = false;
      continue;
    }
    if (inEvent) continue;
    if (CARD_START.test(line)) {
      cardDepth = Math.max(0, bracketDepth(line));
      continue;
    }
    if (/^\[.+ (is|are) typing\]$/.test(line)) continue;
    kept.push(raw);
  }
  return kept.join("\n").trim();
}

const MAX_QUERY_TERMS = 32;

/** Distinct, meaningful query terms: no stopwords, nothing under three characters. */
export function queryTerms(text: string): string[] {
  const terms: string[] = [];
  const seen = new Set<string>();
  for (const t of tokenize(text)) {
    if (t.length < 3 || STOPWORDS.has(t) || seen.has(t)) continue;
    seen.add(t);
    terms.push(t);
    if (terms.length >= MAX_QUERY_TERMS) break;
  }
  return terms;
}

function ftsQuery(terms: string[]): string {
  // tokenize() only yields letters and digits, so quoting is all FTS5 needs.
  return terms.map((t) => `"${t}"`).join(" OR ");
}

// --- search ---

export function searchFts(
  db: Database,
  query: string,
  limit = 5,
  minStrength = 0.0,
): SearchResult[] {
  const terms = [...new Set(tokenize(query))];
  if (terms.length === 0) return [];
  const rows = db
    .prepare(
      `SELECT m.id, m.content, m.source_file, m.source_type, m.section,
              m.strength, m.recall_count, bm25(memories_fts) AS rank
       FROM memories_fts JOIN memories m ON m.id = memories_fts.rowid
       WHERE memories_fts MATCH ? AND m.strength >= ?
       ORDER BY rank
       LIMIT ?`,
    )
    .all(ftsQuery(terms), minStrength, limit) as Array<{
    id: number;
    content: string;
    source_file: string;
    source_type: string;
    section: string;
    strength: number;
    recall_count: number;
    rank: number;
  }>;

  // BM25 rank is negative (closer to 0 = worse). Map through a saturating curve.
  return rows.map((row) => {
    const raw = Math.abs(row.rank);
    const similarity = raw / (raw + 1);
    return {
      id: row.id,
      content: row.content,
      sourceFile: row.source_file,
      sourceType: row.source_type,
      section: row.section,
      similarity,
      weightedSimilarity: similarity * (0.7 + 0.3 * row.strength),
      strength: row.strength,
      recallCount: row.recall_count,
      matchType: "fts" as const,
    };
  });
}

async function searchVector(
  db: Database,
  query: string,
  apiKey: string,
  embedding: EmbeddingConfig,
  limit: number,
): Promise<SearchResult[]> {
  const [queryEmb] = await embed([query], apiKey, embedding);
  const rows = db
    .prepare(
      `SELECT m.id, m.content, m.source_file, m.source_type, m.section, m.strength, m.recall_count,
              vector_distance_cos(e.embedding, vector(?)) AS distance
       FROM embeddings e JOIN memories m ON m.id = e.memory_id
       ORDER BY distance ASC
       LIMIT ?`,
    )
    .all(JSON.stringify(queryEmb), limit * 3) as Array<{
    id: number;
    content: string;
    source_file: string;
    source_type: string;
    section: string;
    strength: number;
    recall_count: number;
    distance: number;
  }>;
  return rows.map((row) => {
    const similarity = 1 - row.distance;
    return {
      id: row.id,
      content: row.content,
      sourceFile: row.source_file,
      sourceType: row.source_type,
      section: row.section,
      similarity,
      weightedSimilarity: similarity * (0.7 + 0.3 * row.strength),
      strength: row.strength,
      recallCount: row.recall_count,
      matchType: "vector" as const,
    };
  });
}

async function search(
  db: Database,
  query: string,
  config: ResonanceConfig,
  limit: number,
  mode: SearchMode,
): Promise<SearchResult[]> {
  const apiKey = getApiKey(config);
  const embedding = config.embedding;
  const canVector = !!(embedding && apiKey && hasEmbeddingsTable(db));

  if (mode === "fts") return searchFts(db, query, limit);
  if (mode === "vector") {
    if (!embedding)
      throw new Error("vector search needs embeddings — see `resonance sync --embed`");
    if (!apiKey) throw new Error(`vector search needs ${embedding.apiKeyEnvVar} to be set`);
    const v = await searchVector(db, query, apiKey, embedding, limit);
    return v.sort((a, b) => b.weightedSimilarity - a.weightedSimilarity).slice(0, limit);
  }

  let vectorResults: SearchResult[] = [];
  if (canVector) {
    try {
      vectorResults = await searchVector(db, query, apiKey!, embedding!, limit);
    } catch {
      // fall back to full-text
    }
  }
  const ftsResults = searchFts(db, query, limit);
  if (vectorResults.length === 0) return ftsResults.slice(0, limit);
  if (ftsResults.length === 0) {
    return vectorResults
      .sort((a, b) => b.weightedSimilarity - a.weightedSimilarity)
      .slice(0, limit);
  }

  const maxVec = Math.max(...vectorResults.map((r) => r.weightedSimilarity));
  const maxFts = Math.max(...ftsResults.map((r) => r.weightedSimilarity));
  const merged = new Map<number, SearchResult>();
  for (const r of vectorResults) {
    const norm = maxVec > 0 ? r.weightedSimilarity / maxVec : 0;
    merged.set(r.id, { ...r, weightedSimilarity: norm * 0.7, matchType: "vector" });
  }
  for (const r of ftsResults) {
    const norm = maxFts > 0 ? r.weightedSimilarity / maxFts : 0;
    const existing = merged.get(r.id);
    if (existing) {
      existing.weightedSimilarity += norm * 0.3;
      existing.matchType = "both";
    } else {
      merged.set(r.id, { ...r, weightedSimilarity: norm * 0.3, matchType: "fts" });
    }
  }
  return [...merged.values()]
    .sort((a, b) => b.weightedSimilarity - a.weightedSimilarity)
    .slice(0, limit);
}

// --- per-turn recall ---

const SURFACE_LIMIT = 3;
const SNIPPET_CHARS = 160;
const SURFACE_MIN_STRENGTH = 0.2;
/**
 * A result must share at least two distinct terms with the message — more for a long
 * message, which shares two words with almost anything — or match strongly enough on
 * fewer (a rare word, repeated). Calibrated against a ~250-chunk corpus, where an
 * incidental single-word match scored up to ~7.
 */
export function minMatchedTerms(termCount: number): number {
  return Math.max(2, Math.ceil(termCount / 8));
}
const BM25_FLOOR = 10;
/** Don't resurface a memory in the same session within this window. */
const DEDUPE_HOURS = 24;

export interface Surfaced {
  id: number;
  sourceFile: string;
  section: string;
  snippet: string;
}

/**
 * Pick the few memories this message genuinely echoes, and mark them surfaced.
 *
 * Quiet by design: most turns should bring back nothing. Everything injected stays in
 * the transcript and costs tokens on every later request, so a weak or repeated match
 * is worse than silence. MEMORY.md is skipped — it's already in the system prompt.
 */
export function surface(
  db: Database,
  prompt: string,
  session: string,
  config: ResonanceConfig,
  now = new Date(),
): Surfaced[] {
  const terms = queryTerms(cleanPrompt(prompt));
  if (terms.length === 0) return [];

  const since = toDbTimestamp(new Date(now.getTime() - DEDUPE_HOURS * 60 * 60 * 1000));
  const rows = db
    .prepare(
      `SELECT m.id, m.content, m.source_file, m.section, m.strength,
              -bm25(memories_fts) AS score,
              snippet(memories_fts, 0, '', '', '…', 24) AS snip
       FROM memories_fts JOIN memories m ON m.id = memories_fts.rowid
       WHERE memories_fts MATCH ?
         AND m.source_type != 'memory'
         AND m.strength >= ?
         AND m.id NOT IN (SELECT memory_id FROM surfaced WHERE session = ? AND surfaced_at >= ?)
       ORDER BY bm25(memories_fts)
       LIMIT 20`,
    )
    .all(ftsQuery(terms), SURFACE_MIN_STRENGTH, session, since) as Array<{
    id: number;
    content: string;
    source_file: string;
    section: string;
    strength: number;
    score: number;
    snip: string;
  }>;

  if (rows.length === 0) return [];

  // How many distinct terms each candidate shares with the message, asked of FTS itself
  // so stemming counts the same way it did for the match.
  const matched = new Map<number, number>();
  const ids = rows.map((r) => r.id);
  const perTerm = db.prepare(
    `SELECT rowid AS id FROM memories_fts WHERE memories_fts MATCH ?
     AND rowid IN (${ids.map(() => "?").join(",")})`,
  );
  for (const t of terms) {
    for (const { id } of perTerm.all(`"${t}"`, ...ids) as Array<{ id: number }>) {
      matched.set(id, (matched.get(id) ?? 0) + 1);
    }
  }

  const needed = minMatchedTerms(terms.length);
  const picked = rows
    .filter((r) => (matched.get(r.id) ?? 0) >= needed || r.score >= BM25_FLOOR)
    .map((r) => ({ r, rank: r.score * (0.7 + 0.3 * r.strength) }))
    .sort((a, b) => b.rank - a.rank)
    .slice(0, SURFACE_LIMIT)
    .map(({ r }) => r);
  if (picked.length === 0) return [];

  const nowTs = toDbTimestamp(now);
  transaction(db, () => {
    const bump = db.prepare(
      "UPDATE memories SET surfaced_count = surfaced_count + 1, strength = MIN(1.0, strength + ?) WHERE id = ?",
    );
    const mark = db.prepare(
      "INSERT OR REPLACE INTO surfaced (session, memory_id, surfaced_at) VALUES (?, ?, ?)",
    );
    for (const r of picked) {
      bump.run(config.dynamics.surfaceBoost, r.id);
      mark.run(session, r.id, nowTs);
    }
  });

  return picked.map((r) => {
    let snippet = r.snip
      .replace(/^#{1,6}\s+.*?(\n|$)/, "")
      .replace(/\s+/g, " ")
      .trim();
    if (snippet.length > SNIPPET_CHARS)
      snippet = `${snippet.slice(0, SNIPPET_CHARS - 1).trimEnd()}…`;
    return { id: r.id, sourceFile: r.source_file, section: r.section, snippet };
  });
}

function headingLabel(section: string): string {
  return section.replace(/^#{1,6}\s+/, "").trim();
}

export function formatSurfaced(items: Surfaced[]): string {
  const lines = ["Resonance — this brought back (`resonance recall <id>` if one mattered):"];
  for (const s of items) {
    const heading = headingLabel(s.section);
    lines.push(`[id:${s.id}] ${s.sourceFile}${heading ? ` § ${heading}` : ""}`);
    lines.push(`  ${s.snippet}`);
  }
  return lines.join("\n");
}

/**
 * Say something to the mind at most once a day per session: a problem it should know
 * about, without repeating it into the transcript every turn.
 */
function noticeOnce(db: Database, session: string, text: string, now = new Date()): string | null {
  const key = `notice:${session}`;
  const prev = getMeta(db, key);
  if (prev) {
    const { text: shown, at } = JSON.parse(prev) as { text: string; at: string };
    const fresh = now.getTime() - parseDbTimestamp(at) < DEDUPE_HOURS * 60 * 60 * 1000;
    if (shown === text && fresh) return null;
  }
  setMeta(db, key, JSON.stringify({ text, at: toDbTimestamp(now) }));
  return text;
}

/**
 * Record a hook failure in `.mind/resonance-hook-errors.log`, once per distinct error.
 * The hook itself always exits cleanly — a failing hook is logged by the mind server on
 * every single turn, and recall failing quietly beats recall failing loudly.
 */
function logHookError(err: unknown): void {
  try {
    const mindDir = mindDirEnv();
    if (!mindDir) return;
    const line = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ");
    const path = join(mindDir, ".mind", "resonance-hook-errors.log");
    const last = existsSync(path) ? readFileSync(path, "utf-8").trimEnd().split("\n").pop() : "";
    if (last?.endsWith(line)) return;
    mkdirSync(join(mindDir, ".mind"), { recursive: true });
    appendFileSync(path, `${new Date().toISOString()} ${line}\n`);
  } catch {
    // nowhere left to report it
  }
}

/** Files synced per turn by the hook; the rest catch up on later turns. */
const HOOK_MAX_FILES = 20;
/**
 * ...and at most this long. Hooks share one 15s budget per turn, and the first turns
 * after an upgrade (a fresh index, a backlog of files) must not eat the notices' share.
 */
const HOOK_MAX_SYNC_MS = 2000;

/**
 * The pre-prompt hook: keep the index current, decay if a day has passed, and — when
 * recall is `auto` — return what this turn echoes. Creates its DB on first run, so a
 * mind never has an install step. Never throws.
 */
export function runHook(input: unknown): { additionalContext?: string } {
  if (!mindDirEnv()) return {};
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const session = typeof obj.session === "string" && obj.session ? obj.session : "main";
  const prompt = typeof obj.prompt === "string" ? obj.prompt : "";

  let db: Database | null = null;
  try {
    let config: ResonanceConfig;
    try {
      config = loadConfig();
    } catch (err) {
      // A hook failure only reaches a log the mind never sees, and recall would just
      // silently stop — so tell the mind, once a day per session, until it's fixed.
      const msg = err instanceof Error ? err.message : String(err);
      db = initDb(getDbPath());
      const notice = noticeOnce(
        db,
        session,
        `Resonance: can't read its settings (${msg}). Recall is paused until it's fixed.`,
      );
      return notice ? { additionalContext: notice } : {};
    }
    if (config.recall === "off") return {};

    db = openDb(config);
    try {
      syncFiles(db, config, HOOK_MAX_FILES, HOOK_MAX_SYNC_MS);
      maybeDecay(db, config);
    } catch (err) {
      // Recall can still work from what is already indexed.
      logHookError(err);
    }

    const parts: string[] = [];
    if (config.warnings) {
      const notice = noticeOnce(db, session, `Resonance: ${config.warnings.join("; ")}.`);
      if (notice) parts.push(notice);
    }
    if (config.recall === "auto" && prompt) {
      const items = surface(db, prompt, session, config);
      if (items.length > 0) parts.push(formatSurfaced(items));
    }
    return parts.length > 0 ? { additionalContext: parts.join("\n\n") } : {};
  } catch (err) {
    logHookError(err);
    return {};
  } finally {
    db?.close();
  }
}

// --- other operations ---

function recallMemories(db: Database, ids: number[], config: ResonanceConfig): number[] {
  const now = toDbTimestamp(new Date());
  const update = db.prepare(
    `UPDATE memories
     SET recall_count = recall_count + 1, last_recalled = ?, strength = MIN(1.0, strength + ?)
     WHERE id = ?`,
  );
  const missing: number[] = [];
  transaction(db, () => {
    for (const id of ids) {
      if (update.run(now, config.dynamics.resonanceBoost, id).changes === 0) missing.push(id);
    }
  });
  return missing;
}

function randomMemories(db: Database, limit: number, minStrength: number, maxStrength: number) {
  return db
    .prepare(
      `SELECT id, content, source_file, section, strength, recall_count
       FROM memories WHERE strength >= ? AND strength <= ?
       ORDER BY RANDOM() LIMIT ?`,
    )
    .all(minStrength, maxStrength, limit) as Array<{
    id: number;
    content: string;
    source_file: string;
    section: string;
    strength: number;
    recall_count: number;
  }>;
}

function label(sourceFile: string, section: string): string {
  const heading = headingLabel(section);
  return `${sourceFile}${heading ? ` § ${heading}` : ""}`;
}

function printStats(db: Database, config: ResonanceConfig): void {
  const one = <T>(sql: string) => db.prepare(sql).get() as T;
  const total = one<{ c: number }>("SELECT COUNT(*) AS c FROM memories").c;
  console.log(`recall: ${config.recall}`);
  console.log(
    `memories: ${total} from ${one<{ c: number }>("SELECT COUNT(*) AS c FROM indexed_files").c} files`,
  );
  if (total === 0) {
    console.log(
      `nothing indexed yet — resonance reads ${config.ingestion.dirs.join(", ")} and ${config.ingestion.files.join(", ")}.`,
    );
    return;
  }
  const byType = db
    .prepare("SELECT source_type, COUNT(*) AS c FROM memories GROUP BY source_type")
    .all() as Array<{ source_type: string; c: number }>;
  console.log(`by type: ${byType.map((r) => `${r.source_type} ${r.c}`).join(", ")}`);
  console.log(
    `avg strength: ${one<{ a: number }>("SELECT AVG(strength) AS a FROM memories").a.toFixed(3)}`,
  );
  if (config.embedding) {
    const n = hasEmbeddingsTable(db)
      ? one<{ c: number }>("SELECT COUNT(*) AS c FROM embeddings").c
      : 0;
    console.log(`embeddings: ${n}/${total} (${config.embedding.model})`);
  }
  const last = getMeta(db, "last_decay_at");
  if (last) console.log(`last decay: ${last} UTC`);

  const show = (title: string, sql: string, fmt: (r: any) => string) => {
    const rows = db.prepare(sql).all() as any[];
    if (rows.length === 0) return;
    console.log(`\n${title}:`);
    for (const r of rows)
      console.log(
        `  ${fmt(r)} ${label(r.source_file, r.section)}: ${r.content.slice(0, 80).replace(/\s+/g, " ")}`,
      );
  };
  show(
    "most recalled",
    "SELECT * FROM memories WHERE recall_count > 0 ORDER BY recall_count DESC LIMIT 5",
    (r) => `[id:${r.id} ${r.recall_count}x]`,
  );
  show(
    "most surfaced",
    "SELECT * FROM memories WHERE surfaced_count > 0 ORDER BY surfaced_count DESC LIMIT 5",
    (r) => `[id:${r.id} ${r.surfaced_count}x]`,
  );
  show(
    "drifting",
    "SELECT * FROM memories WHERE strength < 0.5 ORDER BY strength ASC LIMIT 5",
    (r) => `[id:${r.id} str ${r.strength.toFixed(2)}]`,
  );
}

// --- cli ---

/**
 * Read the memory ids for `recall`, refusing anything that is not exactly digits.
 *
 * `recall` is a *write* — it boosts the strength of the rows it names. `parseInt` salvaged
 * a leading prefix, so `recall 1e9` boosted memory id 1 and printed "recalled 1 memories";
 * a non-numeric id was filtered out of the list in silence. Either way the mind was told
 * it had recalled something it hadn't, and a different memory got the boost.
 */
export function parseRecallIds(raw: string[]): number[] {
  const ids: number[] = [];
  for (const s of raw) {
    if (!/^\d+$/.test(s)) {
      console.error(`error: recall expects memory ids (whole numbers), got: ${s}`);
      process.exit(1);
    }
    ids.push(Number(s));
  }
  return ids;
}

/**
 * Read `--limit N` off argv, refusing anything that is not exactly a positive integer.
 *
 * This is a mind's own memory-search instrument, which makes it the worst possible place
 * for a quiet substitution. `parseInt` gave both: `--limit notanumber` produced NaN, which
 * SQLite binds as NULL — and `LIMIT NULL` is *unlimited*, so a typo silently returned the
 * whole store; `--limit 1e9` parsed as 1 and returned a single memory. Either way the
 * output is real memories, correctly ranked, answering a question nobody asked, and a mind
 * has no way to tell that from a genuine result.
 */
export function readLimitFlag(args: string[], fallback: number): number {
  const idx = args.indexOf("--limit");
  if (idx === -1) return fallback;
  // A trailing `--limit` has nothing to consume — a shell that ate the value would
  // otherwise search at the default and print five real memories. Same refusal
  // `parse-args.ts` gives the CLI ("--limit requires a value"); falling back here would
  // be the exact silent substitution this function was added to remove.
  const raw = args[idx + 1];
  if (raw === undefined) {
    console.error("error: --limit requires a value");
    process.exit(1);
  }
  if (!/^\d+$/.test(raw) || Number(raw) < 1) {
    console.error(`error: --limit expects a positive whole number, got: ${raw}`);
    process.exit(1);
  }
  return Number(raw);
}

/**
 * Read a `--min-strength` / `--max-strength` value, refusing anything outside 0.0-1.0.
 *
 * `parseFloat` gave NaN for a typo, which SQLite binds as NULL; `strength >= NULL` is
 * NULL, so no row matches and the command prints "no memories in the specified strength
 * range." A mind reads that as a finding about its own memory store rather than as a
 * rejected argument — a false negative dressed as a result. Strength lives in [0, 1]
 * (rows start at 1.0 and decay, and boosts are `MIN(1.0, ...)`), so a bound outside that
 * can only ever return nothing and is refused too.
 */
export function readStrengthFlag(args: string[], flag: string, fallback: number): number {
  const idx = args.indexOf(flag);
  if (idx === -1) return fallback;
  const raw = args[idx + 1];
  if (raw === undefined) {
    console.error(`error: ${flag} requires a value`);
    process.exit(1);
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    console.error(`error: ${flag} expects a number between 0.0 and 1.0, got: ${raw}`);
    process.exit(1);
  }
  return n;
}

const USAGE = "Usage: resonance <search|recall|random|sync|stats> [args]";

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (cmd === "search-hook") {
    let raw = "";
    try {
      for await (const chunk of process.stdin) raw += chunk;
    } catch {
      // unreadable stdin is just no input
    }
    let input: unknown = {};
    try {
      input = JSON.parse(raw);
    } catch {
      // no usable input — sync anyway, surface nothing
    }
    console.log(JSON.stringify(runHook(input)));
    return;
  }

  if (!cmd || !["search", "recall", "random", "sync", "stats"].includes(cmd)) {
    if (cmd) console.error(`unknown command: ${cmd}`);
    console.log(USAGE);
    process.exit(cmd ? 1 : 0);
  }

  const config = loadConfig();
  const db = openDb(config);
  try {
    // Every command sees an up-to-date index, whatever the recall mode.
    const synced = syncFiles(db, config);
    maybeDecay(db, config);

    if (cmd === "sync") {
      console.log(
        `indexed ${synced.indexed} changed file${synced.indexed === 1 ? "" : "s"}` +
          (synced.removed ? `, dropped ${synced.removed} deleted` : ""),
      );
      if (args.includes("--embed")) {
        const n = await embedMissing(db, config);
        console.log(`embedded ${n} memor${n === 1 ? "y" : "ies"}`);
      }
    } else if (cmd === "search") {
      if (!args[1]) {
        console.log('Usage: resonance search "query" [--limit N] [--fts] [--vector]');
        process.exit(1);
      }
      const limit = readLimitFlag(args, 5);
      const mode: SearchMode = args.includes("--fts")
        ? "fts"
        : args.includes("--vector")
          ? "vector"
          : "hybrid";
      const results = await search(db, args[1], config, limit, mode);
      if (results.length === 0) {
        const total = (db.prepare("SELECT COUNT(*) AS c FROM memories").get() as { c: number }).c;
        console.log(total === 0 ? "nothing indexed yet." : "nothing resonant for this query.");
      }
      results.forEach((r, i) => {
        const tag = mode === "hybrid" && r.matchType !== "fts" ? ` [${r.matchType}]` : "";
        console.log(
          `\n--- ${i + 1}. [id:${r.id}] ${label(r.sourceFile, r.section)} (sim ${r.similarity.toFixed(3)}, str ${r.strength.toFixed(2)}, recalls ${r.recallCount})${tag} ---`,
        );
        console.log(r.content.slice(0, 300));
      });
    } else if (cmd === "recall") {
      if (!args[1]) {
        console.log("Usage: resonance recall <id> [id2 id3 ...]");
        process.exit(1);
      }
      const ids = parseRecallIds(args.slice(1));
      const missing = recallMemories(db, ids, config);
      const done = ids.length - missing.length;
      if (done > 0) {
        console.log(
          `recalled ${done} memor${done === 1 ? "y" : "ies"} (strength +${config.dynamics.resonanceBoost})`,
        );
      }
      if (missing.length > 0) {
        console.error(`no memory with id ${missing.join(", ")}`);
        process.exit(1);
      }
    } else if (cmd === "random") {
      const limit = readLimitFlag(args, 5);
      const minStr = readStrengthFlag(args, "--min-strength", 0.0);
      const maxStr = readStrengthFlag(args, "--max-strength", 1.0);
      const results = randomMemories(db, limit, minStr, maxStr);
      if (results.length === 0) console.log("no memories in the specified strength range.");
      results.forEach((r, i) => {
        console.log(
          `\n--- ${i + 1}. [id:${r.id}] ${label(r.source_file, r.section)} (str ${r.strength.toFixed(2)}, recalls ${r.recall_count}) ---`,
        );
        console.log(r.content.slice(0, 300));
      });
    } else if (cmd === "stats") {
      printStats(db, config);
    }
  } finally {
    db.close();
  }
}

// Only run CLI when executed directly (not when imported by tests)
const isDirectRun =
  process.argv[1] !== undefined &&
  (import.meta.url === `file://${process.argv[1]}` ||
    import.meta.url === `file://${resolve(process.argv[1])}`);

if (isDirectRun) {
  main().catch((err) => {
    if (process.argv[2] === "search-hook") {
      logHookError(err);
      console.log("{}");
      return;
    }
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
