#!/usr/bin/env tsx

/**
 * resonance.ts — semantic memory engine
 *
 * Stores text as vector embeddings, finds cross-memory connections via cosine similarity.
 * Memories have strength/decay dynamics — recalled memories strengthen, unused ones drift.
 *
 * Usage:
 *   resonance ingest <file>              # ingest a file (splits into chunks)
 *   resonance ingest-all                 # ingest all configured memory files
 *   resonance search "query" [--limit N] # find resonant memories
 *   resonance recall <id> [id2 ...]      # boost specific memories (explicit recall)
 *   resonance random [--limit N]         # pull random memories (for dreams)
 *   resonance report [--against <file>]  # find cross-memory connections
 *   resonance stats                      # db statistics
 *   resonance decay                      # run decay pass
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, join, resolve } from "node:path";

const libsqlRequire = createRequire(import.meta.url);

// --- types ---

interface ResonanceConfig {
  embedding: {
    provider: string;
    url: string;
    model: string;
    dimensions: number;
    apiKeyEnvVar: string;
  };
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
  };
}

interface Chunk {
  content: string;
  sourceFile: string;
  sourceType: string;
  chunkIndex: number;
  contentHash: string;
  metadata: Record<string, string>;
}

type SearchMode = "hybrid" | "fts" | "vector";

interface SearchResult {
  id: number;
  content: string;
  sourceFile: string;
  sourceType: string;
  distance: number;
  similarity: number;
  weightedSimilarity: number;
  strength: number;
  recallCount: number;
  createdAt: string;
  metadata: Record<string, string>;
  matchType: "vector" | "fts" | "both";
}

// --- config ---

export function loadConfig(): ResonanceConfig {
  const defaultConfigPath = resolve(
    new URL(".", import.meta.url).pathname,
    "..",
    "assets",
    "default-config.json",
  );
  const defaultConfig: ResonanceConfig = JSON.parse(readFileSync(defaultConfigPath, "utf-8"));

  const mindDir = process.env.VOLUTE_MIND_DIR;
  if (!mindDir) return defaultConfig;

  const overridePath = join(mindDir, "home", ".config", "resonance.json");
  if (!existsSync(overridePath)) return defaultConfig;

  const override = JSON.parse(readFileSync(overridePath, "utf-8"));
  if (typeof override !== "object" || override === null) {
    throw new Error("Invalid resonance.json: must be a JSON object");
  }
  for (const key of ["embedding", "ingestion", "dynamics"] as const) {
    if (key in override && (typeof override[key] !== "object" || override[key] === null)) {
      throw new Error(`Invalid resonance.json: "${key}" must be an object`);
    }
  }
  return {
    embedding: { ...defaultConfig.embedding, ...override.embedding },
    ingestion: { ...defaultConfig.ingestion, ...override.ingestion },
    dynamics: { ...defaultConfig.dynamics, ...override.dynamics },
  };
}

function getDbPath(): string {
  const mindDir = process.env.VOLUTE_MIND_DIR;
  if (!mindDir) throw new Error("VOLUTE_MIND_DIR not set");
  const dir = join(mindDir, ".mind");
  mkdirSync(dir, { recursive: true });
  return join(dir, "resonance.db");
}

function getHomePath(): string {
  const mindDir = process.env.VOLUTE_MIND_DIR;
  if (!mindDir) throw new Error("VOLUTE_MIND_DIR not set");
  return join(mindDir, "home");
}

function getApiKey(config: ResonanceConfig): string | null {
  return process.env[config.embedding.apiKeyEnvVar] || null;
}

function getSkillDir(): string {
  return resolve(new URL(".", import.meta.url).pathname, "..");
}

function isInstalled(): boolean {
  const mindDir = process.env.VOLUTE_MIND_DIR;
  if (!mindDir) return false;
  return existsSync(join(mindDir, ".mind", "resonance.db"));
}

function requireInstalled(): void {
  if (!isInstalled()) {
    console.error(
      "resonance is not set up yet. run: npx tsx .claude/skills/resonance/scripts/resonance.ts install",
    );
    process.exit(1);
  }
}

async function runInstall(config: ResonanceConfig): Promise<void> {
  const mindDir = process.env.VOLUTE_MIND_DIR;
  if (!mindDir) {
    console.error("VOLUTE_MIND_DIR not set — are you running inside a mind?");
    process.exit(1);
  }

  // 1. Check API key (optional — enables vector search)
  const apiKeyVar = config.embedding.apiKeyEnvVar;
  const apiKey = getApiKey(config);
  if (apiKey) {
    console.log("verifying embedding API key...");
    try {
      await embed(["test"], apiKey, config);
      console.log("API key verified.");
    } catch (e) {
      console.error(`embedding API test failed: ${e instanceof Error ? e.message : e}`);
      console.error("continuing without embeddings — full-text search will still work.");
    }
  } else {
    console.log(`no ${apiKeyVar} set — installing with full-text search only.`);
    console.log(`to enable vector search later: volute env set ${apiKeyVar} <your-key>`);
  }

  // 2. Copy default config if none exists
  const configPath = join(mindDir, "home", ".config", "resonance.json");
  if (!existsSync(configPath)) {
    const defaultConfig = join(getSkillDir(), "assets", "default-config.json");
    mkdirSync(join(mindDir, "home", ".config"), { recursive: true });
    copyFileSync(defaultConfig, configPath);
    console.log("created .config/resonance.json (edit to customize).");
  } else {
    console.log(".config/resonance.json already exists, keeping it.");
  }

  // 3. Initialize DB
  const db = initDb(getDbPath(), config.embedding.dimensions);
  db.close();
  console.log("initialized resonance database.");

  // 4. Set up nightly schedule
  const scriptPath = ".claude/skills/resonance/scripts/resonance.ts";
  const script = `npx tsx ${scriptPath} ingest-all && npx tsx ${scriptPath} decay`;
  try {
    await execFileAsync("volute", [
      "schedule",
      "add",
      "--cron",
      "0 22 * * *",
      "--script",
      script,
      "--id",
      "resonance-nightly",
    ]);
    console.log('added nightly schedule "resonance-nightly" (10pm: ingest-all + decay).');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`note: could not add schedule automatically: ${msg}`);
    console.log("you can add it manually:");
    console.log(
      `  volute schedule add --cron "0 22 * * *" --script "${script}" --id resonance-nightly`,
    );
  }

  // 5. Run initial ingestion
  console.log("\nrunning initial ingestion...");
  const db2 = initDb(getDbPath(), config.embedding.dimensions);
  try {
    const results = await ingestAll(db2, apiKey, config);
    let total = 0;
    for (const [path, count] of Object.entries(results)) {
      if (count > 0) console.log(`  ${basename(path)}: ${count} chunks`);
      total += count;
    }
    console.log(`ingested ${total} chunks${apiKey ? "" : " (FTS only, no embeddings)"}.`);
  } finally {
    db2.close();
  }

  console.log("\nresonance is ready.");
}

// --- database ---

type Database = import("libsql").Database;

export function initDb(dbPath: string, dimensions = 1536): Database {
  const Database = libsqlRequire("libsql");
  const db = new Database(dbPath) as Database;
  db.exec("PRAGMA journal_mode=WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      source_file TEXT,
      source_type TEXT,
      chunk_index INTEGER DEFAULT 0,
      content_hash TEXT UNIQUE,
      embedding F32_BLOB(${dimensions}),
      strength REAL DEFAULT 1.0,
      recall_count INTEGER DEFAULT 0,
      last_recalled TEXT,
      last_decayed TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      metadata TEXT
    )
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_memories_source ON memories(source_file)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_memories_strength ON memories(strength DESC)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_memories_hash ON memories(content_hash)");

  // FTS5 full-text search index
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      content, source_file,
      content='memories', content_rowid='id'
    )
  `);
  // Triggers to keep FTS in sync
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, content, source_file)
      VALUES (new.id, new.content, new.source_file);
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content, source_file)
      VALUES ('delete', old.id, old.content, old.source_file);
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content, source_file)
      VALUES ('delete', old.id, old.content, old.source_file);
      INSERT INTO memories_fts(rowid, content, source_file)
      VALUES (new.id, new.content, new.source_file);
    END
  `);

  return db;
}

// --- embedding ---

async function embed(
  texts: string[],
  apiKey: string,
  config: ResonanceConfig,
): Promise<number[][]> {
  const resp = await fetch(config.embedding.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.embedding.model,
      input: texts,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Embedding API error ${resp.status}: ${body}`);
  }

  const data = (await resp.json()) as {
    data: Array<{ index: number; embedding: number[] }>;
  };
  return data.data.sort((a, b) => a.index - b.index).map((e) => e.embedding);
}

function vecToJson(vec: number[]): string {
  return JSON.stringify(vec);
}

// --- chunking ---

export function detectSourceType(sourceFile: string): string {
  const sf = sourceFile.toLowerCase();
  if (sf.includes("journal")) return "journal";
  if (sf.includes("reading")) return "reading";
  if (sf.includes("topic")) return "topic";
  if (sf.endsWith("memory.md")) return "memory";
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
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= chunkSize) {
    return [
      {
        content: text,
        sourceFile,
        sourceType,
        chunkIndex: 0,
        contentHash: "",
        metadata: {},
      },
    ];
  }

  const chunks: Chunk[] = [];
  let start = 0;
  while (start < words.length) {
    const end = Math.min(start + chunkSize, words.length);
    chunks.push({
      content: words.slice(start, end).join(" "),
      sourceFile,
      sourceType,
      chunkIndex: 0,
      contentHash: "",
      metadata: {},
    });
    if (end >= words.length) break;
    start += chunkSize - chunkOverlap;
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
  let currentHeader = "";

  for (let i = 0; i < sections.length; i++) {
    let part = sections[i].trim();
    if (/^#{1,6}\s+/.test(part)) {
      currentHeader = part;
      continue;
    }
    if (!part) continue;

    // Strip ignored lines if patterns configured
    if (ignoreRe.length > 0) {
      part = stripIgnoredLines(part, ignoreRe);
      if (!part || part.split(/\s+/).length < 10) continue;
    }

    const sectionText = currentHeader ? `${currentHeader}\n\n${part}` : part;
    const words = sectionText.split(/\s+/).filter(Boolean);

    if (words.length < 15) continue;

    if (words.length <= config.ingestion.chunkSize) {
      chunks.push({
        content: sectionText,
        sourceFile,
        sourceType,
        chunkIndex: 0,
        contentHash: "",
        metadata: { section: currentHeader },
      });
    } else {
      const subChunks = chunkByWords(
        sectionText,
        sourceFile,
        sourceType,
        config.ingestion.chunkSize,
        config.ingestion.chunkOverlap,
      );
      for (const sc of subChunks) {
        sc.metadata = { section: currentHeader };
      }
      chunks.push(...subChunks);
    }
  }
  return chunks;
}

export function chunkText(text: string, sourceFile: string, config: ResonanceConfig): Chunk[] {
  text = text.trim();
  if (!text) return [];

  const sourceType = detectSourceType(sourceFile);
  const ignoreRe = config.ingestion.ignorePatterns.map((p) => new RegExp(p, "m"));

  // Split on markdown headers for all markdown files
  if (/\n#{1,6}\s+/.test(text)) {
    return chunkBySections(text, sourceFile, sourceType, config, ignoreRe);
  }

  // Fallback: sliding window by words
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length < 15) return [];
  return chunkByWords(
    text,
    sourceFile,
    sourceType,
    config.ingestion.chunkSize,
    config.ingestion.chunkOverlap,
  );
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

// --- operations ---

async function ingestFile(
  db: Database,
  filePath: string,
  apiKey: string | null,
  config: ResonanceConfig,
): Promise<number> {
  const text = readFileSync(filePath, "utf-8");
  const chunks = chunkText(text, filePath, config);
  if (chunks.length === 0) return 0;

  // Assign indices and hashes
  for (let i = 0; i < chunks.length; i++) {
    chunks[i].chunkIndex = i;
    chunks[i].contentHash = hashContent(chunks[i].content);
  }

  // Check which chunks are new
  const checkStmt = db.prepare("SELECT id FROM memories WHERE content_hash = ?");
  const currentHashes = new Set(chunks.map((c) => c.contentHash));
  const newChunks = chunks.filter((c) => !checkStmt.get(c.contentHash));

  // Remove stale chunks from previous versions of this file
  const staleRows = db
    .prepare("SELECT id, content_hash FROM memories WHERE source_file = ?")
    .all(filePath) as Array<{ id: number; content_hash: string }>;
  const staleIds = staleRows.filter((r) => !currentHashes.has(r.content_hash)).map((r) => r.id);
  if (staleIds.length > 0) {
    db.prepare(`DELETE FROM memories WHERE id IN (${staleIds.map(() => "?").join(",")})`).run(
      ...staleIds,
    );
  }

  if (newChunks.length === 0) return -staleIds.length; // negative = only removals

  if (apiKey) {
    // Full ingestion with embeddings
    const insertStmt = db.prepare(`
      INSERT OR IGNORE INTO memories
        (content, source_file, source_type, chunk_index, content_hash, embedding, metadata)
      VALUES (?, ?, ?, ?, ?, vector(?), ?)
    `);

    const batchSize = 20;
    for (let batchStart = 0; batchStart < newChunks.length; batchStart += batchSize) {
      const batch = newChunks.slice(batchStart, batchStart + batchSize);
      const texts = batch.map((c) => c.content.slice(0, 8000));
      const embeddings = await embed(texts, apiKey, config);

      db.exec("BEGIN");
      try {
        for (let j = 0; j < batch.length; j++) {
          const chunk = batch[j];
          insertStmt.run(
            chunk.content,
            chunk.sourceFile,
            chunk.sourceType,
            chunk.chunkIndex,
            chunk.contentHash,
            vecToJson(embeddings[j]),
            JSON.stringify(chunk.metadata),
          );
        }
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }

      if (batchStart + batchSize < newChunks.length) {
        await new Promise((r) => setTimeout(r, 500)); // rate limiting
      }
    }
  } else {
    // FTS-only ingestion (no embeddings)
    const insertStmt = db.prepare(`
      INSERT OR IGNORE INTO memories
        (content, source_file, source_type, chunk_index, content_hash, metadata)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    db.exec("BEGIN");
    try {
      for (const chunk of newChunks) {
        insertStmt.run(
          chunk.content,
          chunk.sourceFile,
          chunk.sourceType,
          chunk.chunkIndex,
          chunk.contentHash,
          JSON.stringify(chunk.metadata),
        );
      }
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }

  return newChunks.length;
}

async function ingestAll(
  db: Database,
  apiKey: string | null,
  config: ResonanceConfig,
): Promise<Record<string, number>> {
  const home = getHomePath();
  const results: Record<string, number> = {};

  for (const file of config.ingestion.files) {
    const filePath = join(home, file);
    if (existsSync(filePath)) {
      results[file] = await ingestFile(db, filePath, apiKey, config);
    } else {
      console.error(`  warning: configured file not found: ${file}`);
    }
  }

  for (const dir of config.ingestion.dirs) {
    const dirPath = join(home, dir);
    if (!existsSync(dirPath)) {
      console.error(`  warning: configured directory not found: ${dir}`);
      continue;
    }
    const files = readdirSync(dirPath)
      .filter((f) => f.endsWith(".md"))
      .sort();
    for (const file of files) {
      const filePath = join(dirPath, file);
      const key = join(dir, file);
      results[key] = await ingestFile(db, filePath, apiKey, config);
    }
  }

  return results;
}

export function searchFts(
  db: Database,
  query: string,
  limit = 5,
  minStrength = 0.0,
): SearchResult[] {
  // Sanitize and build FTS5 query — strip special syntax, quote each term
  const ftsQuery = query
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.replace(/["""()*^{}:]/g, "").replace(/\b(AND|OR|NOT|NEAR)\b/gi, ""))
    .filter((w) => w.length > 0)
    .map((w) => `"${w}"`)
    .join(" OR ");

  if (!ftsQuery) return [];

  const rows = db
    .prepare(
      `SELECT m.id, m.content, m.source_file, m.source_type,
              m.strength, m.recall_count, m.created_at, m.metadata,
              rank
       FROM memories_fts f
       JOIN memories m ON m.id = f.rowid
       WHERE memories_fts MATCH ? AND m.strength >= ?
       ORDER BY rank
       LIMIT ?`,
    )
    .all(ftsQuery, minStrength, limit) as Array<{
    id: number;
    content: string;
    source_file: string;
    source_type: string;
    strength: number;
    recall_count: number;
    created_at: string;
    metadata: string;
    rank: number;
  }>;

  // BM25 rank is negative (closer to 0 = worse match). Convert to a positive score.
  // Use a sigmoid-like mapping so scores stay bounded but don't inflate weak matches.
  return rows.map((row) => {
    const rawScore = Math.abs(row.rank);
    // Map raw BM25 score through a saturating curve: score / (score + 1)
    // This gives 0.5 at rawScore=1, ~0.91 at rawScore=10, approaching 1.0 asymptotically
    const similarity = rawScore / (rawScore + 1);
    return {
      id: row.id,
      content: row.content,
      sourceFile: row.source_file,
      sourceType: row.source_type,
      distance: 1 - similarity,
      similarity,
      weightedSimilarity: similarity * (0.7 + 0.3 * row.strength),
      strength: row.strength,
      recallCount: row.recall_count,
      createdAt: row.created_at,
      metadata: row.metadata ? JSON.parse(row.metadata) : {},
      matchType: "fts" as const,
    };
  });
}

async function searchVector(
  db: Database,
  query: string,
  apiKey: string,
  config: ResonanceConfig,
  limit = 5,
  minStrength = 0.0,
): Promise<SearchResult[]> {
  const [queryEmb] = await embed([query], apiKey, config);
  const queryVec = vecToJson(queryEmb);

  const rows = db
    .prepare(
      `SELECT id, content, source_file, source_type,
              vector_distance_cos(embedding, vector(?)) AS distance,
              strength, recall_count, created_at, metadata
       FROM memories
       WHERE embedding IS NOT NULL AND strength >= ?
       ORDER BY distance ASC
       LIMIT ?`,
    )
    .all(queryVec, minStrength, limit * 3) as Array<{
    id: number;
    content: string;
    source_file: string;
    source_type: string;
    distance: number;
    strength: number;
    recall_count: number;
    created_at: string;
    metadata: string;
  }>;

  // Weight by strength — stronger memories surface more easily
  return rows.map((row) => {
    const similarity = 1 - row.distance;
    const weightedSimilarity = similarity * (0.7 + 0.3 * row.strength);
    return {
      id: row.id,
      content: row.content,
      sourceFile: row.source_file,
      sourceType: row.source_type,
      distance: row.distance,
      similarity,
      weightedSimilarity,
      strength: row.strength,
      recallCount: row.recall_count,
      createdAt: row.created_at,
      metadata: row.metadata ? JSON.parse(row.metadata) : {},
      matchType: "vector" as const,
    };
  });
}

async function search(
  db: Database,
  query: string,
  apiKey: string | null,
  config: ResonanceConfig,
  limit = 5,
  minStrength = 0.0,
  mode: SearchMode = "hybrid",
): Promise<SearchResult[]> {
  let results: SearchResult[];

  if (mode === "fts") {
    results = searchFts(db, query, limit, minStrength);
  } else if (mode === "vector") {
    if (!apiKey) throw new Error("vector search requires an API key");
    const vectorResults = await searchVector(db, query, apiKey, config, limit, minStrength);
    vectorResults.sort((a, b) => b.weightedSimilarity - a.weightedSimilarity);
    results = vectorResults.slice(0, limit);
  } else {
    // Hybrid: combine vector + FTS results
    let vectorResults: SearchResult[] = [];
    if (apiKey) {
      try {
        vectorResults = await searchVector(db, query, apiKey, config, limit, minStrength);
      } catch {
        // Fall back to FTS-only if vector search fails
      }
    }
    const ftsResults = searchFts(db, query, limit, minStrength);

    if (vectorResults.length === 0) {
      results = ftsResults.slice(0, limit);
    } else if (ftsResults.length === 0) {
      vectorResults.sort((a, b) => b.weightedSimilarity - a.weightedSimilarity);
      results = vectorResults.slice(0, limit);
    } else {
      // Merge: normalize scores across both sets, blend with weighting
      const vectorWeight = 0.7;
      const ftsWeight = 0.3;

      // Normalize vector similarities to 0-1 within this result set
      const maxVecSim = Math.max(...vectorResults.map((r) => r.weightedSimilarity));
      const maxFtsSim = Math.max(...ftsResults.map((r) => r.weightedSimilarity));

      const merged = new Map<number, SearchResult>();

      for (const r of vectorResults) {
        const normVec = maxVecSim > 0 ? r.weightedSimilarity / maxVecSim : 0;
        merged.set(r.id, {
          ...r,
          weightedSimilarity: normVec * vectorWeight,
          matchType: "vector",
        });
      }

      for (const r of ftsResults) {
        const normFts = maxFtsSim > 0 ? r.weightedSimilarity / maxFtsSim : 0;
        const existing = merged.get(r.id);
        if (existing) {
          // Found in both — combine scores
          existing.weightedSimilarity += normFts * ftsWeight;
          existing.matchType = "both";
        } else {
          merged.set(r.id, {
            ...r,
            weightedSimilarity: normFts * ftsWeight,
            matchType: "fts",
          });
        }
      }

      const combined = [...merged.values()];
      combined.sort((a, b) => b.weightedSimilarity - a.weightedSimilarity);
      results = combined.slice(0, limit);
    }
  }

  return results;
}

function recallMemories(db: Database, ids: number[], config: ResonanceConfig): void {
  if (ids.length === 0) return;
  const now = new Date().toISOString().replace("T", " ").slice(0, 19);
  const updateStmt = db.prepare(
    `UPDATE memories
     SET recall_count = recall_count + 1,
         last_recalled = ?,
         strength = MIN(1.0, strength + ?)
     WHERE id = ?`,
  );
  for (const id of ids) {
    updateStmt.run(now, config.dynamics.resonanceBoost, id);
  }
}

function runDecay(db: Database, config: ResonanceConfig): { decayed: number; total: number } {
  const rows = db
    .prepare("SELECT id, strength, last_recalled, last_decayed, created_at FROM memories")
    .all() as Array<{
    id: number;
    strength: number;
    last_recalled: string | null;
    last_decayed: string | null;
    created_at: string;
  }>;

  const now = new Date();
  const nowIso = now.toISOString().slice(0, 19).replace("T", " ");
  const updateStmt = db.prepare("UPDATE memories SET strength = ?, last_decayed = ? WHERE id = ?");
  let decayed = 0;

  for (const row of rows) {
    // Use last_decayed if available, otherwise fall back to last_recalled or created_at
    const since = row.last_decayed || row.last_recalled || row.created_at;
    if (!since) continue;
    const sinceMs = new Date(since).getTime();
    if (Number.isNaN(sinceMs)) continue;
    const daysSince = Math.floor((now.getTime() - sinceMs) / (1000 * 60 * 60 * 24));
    if (daysSince <= 0) continue;

    const newStrength = Math.max(
      config.dynamics.minStrength,
      row.strength - config.dynamics.decayRate * daysSince,
    );
    if (newStrength !== row.strength) {
      updateStmt.run(newStrength, nowIso, row.id);
      decayed++;
    }
  }

  return { decayed, total: rows.length };
}

interface RandomResult {
  id: number;
  content: string;
  sourceFile: string;
  sourceType: string;
  strength: number;
  recallCount: number;
  createdAt: string;
}

function randomMemories(
  db: Database,
  limit = 5,
  minStrength = 0.0,
  maxStrength = 1.0,
): RandomResult[] {
  return (
    db
      .prepare(
        `SELECT id, content, source_file, source_type, strength, recall_count, created_at
       FROM memories
       WHERE strength >= ? AND strength <= ?
       ORDER BY RANDOM()
       LIMIT ?`,
      )
      .all(minStrength, maxStrength, limit) as Array<{
      id: number;
      content: string;
      source_file: string;
      source_type: string;
      strength: number;
      recall_count: number;
      created_at: string;
    }>
  ).map((row) => ({
    id: row.id,
    content: row.content,
    sourceFile: row.source_file,
    sourceType: row.source_type,
    strength: row.strength,
    recallCount: row.recall_count,
    createdAt: row.created_at,
  }));
}

async function resonanceReport(
  db: Database,
  apiKey: string | null,
  config: ResonanceConfig,
  againstFile?: string,
): Promise<string> {
  let text: string;
  let source: string;

  if (againstFile) {
    const filePath = resolve(againstFile);
    if (!existsSync(filePath)) return `file not found: ${filePath}`;
    text = readFileSync(filePath, "utf-8");
    source = filePath;
  } else {
    const home = getHomePath();
    const today = new Date().toISOString().slice(0, 10);
    const journalPath = join(home, "memory", "journal", `${today}.md`);
    if (!existsSync(journalPath)) return "no journal entry for today.";
    text = readFileSync(journalPath, "utf-8");
    source = journalPath;
  }

  const chunks = chunkText(text, source, config);
  if (chunks.length === 0) return "nothing to search against.";

  interface Resonance {
    queryExcerpt: string;
    matchExcerpt: string;
    source: string;
    similarity: number;
    strength: number;
    recallCount: number;
  }

  const allResonances: Resonance[] = [];
  const searchChunks = chunks.slice(0, 10);

  for (const chunk of searchChunks) {
    const results = await search(db, chunk.content.slice(0, 2000), apiKey, config, 3);
    for (const r of results) {
      if (r.sourceFile === source) continue;
      if (r.similarity < 0.4) continue;
      allResonances.push({
        queryExcerpt: `${chunk.content.slice(0, 100)}...`,
        matchExcerpt: `${r.content.slice(0, 200)}...`,
        source: r.sourceFile,
        similarity: r.similarity,
        strength: r.strength,
        recallCount: r.recallCount,
      });
    }
  }

  if (allResonances.length === 0) return "no strong resonances found today.";

  // Deduplicate
  const seen = new Set<string>();
  const unique: Resonance[] = [];
  for (const r of allResonances) {
    const key = `${r.source}:${r.similarity.toFixed(2)}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(r);
    }
  }

  unique.sort((a, b) => b.similarity - a.similarity);

  const lines = ["# resonance report", ""];
  for (const r of unique.slice(0, 10)) {
    const sourceShort = basename(r.source);
    lines.push(
      `**${sourceShort}** (sim: ${r.similarity.toFixed(3)}, strength: ${r.strength.toFixed(2)}, recalls: ${r.recallCount})`,
    );
    lines.push(`> ${r.matchExcerpt.slice(0, 150)}`);
    lines.push(`  <- triggered by: ${r.queryExcerpt.slice(0, 80)}`);
    lines.push("");
  }

  return lines.join("\n");
}

function getStats(db: Database): Record<string, unknown> {
  const total = (db.prepare("SELECT COUNT(*) as c FROM memories").get() as { c: number }).c;
  const byType = db
    .prepare("SELECT source_type, COUNT(*) as c FROM memories GROUP BY source_type")
    .all() as Array<{ source_type: string; c: number }>;
  const avgRow = db.prepare("SELECT AVG(strength) as a FROM memories").get() as {
    a: number | null;
  };
  const avgStrength = avgRow.a != null ? Math.round(avgRow.a * 1000) / 1000 : 0;
  const mostRecalled = db
    .prepare(
      "SELECT content, recall_count, source_file FROM memories ORDER BY recall_count DESC LIMIT 5",
    )
    .all() as Array<{ content: string; recall_count: number; source_file: string }>;
  const strongest = db
    .prepare("SELECT content, strength, source_file FROM memories ORDER BY strength DESC LIMIT 5")
    .all() as Array<{ content: string; strength: number; source_file: string }>;
  const weakest = db
    .prepare(
      "SELECT content, strength, source_file FROM memories WHERE strength < 0.5 ORDER BY strength ASC LIMIT 5",
    )
    .all() as Array<{ content: string; strength: number; source_file: string }>;

  return {
    total_memories: total,
    by_type: Object.fromEntries(byType.map((r) => [r.source_type, r.c])),
    avg_strength: avgStrength,
    most_recalled: mostRecalled.map((r) => ({
      content: r.content.slice(0, 80),
      recalls: r.recall_count,
      source: basename(r.source_file),
    })),
    strongest: strongest.map((r) => ({
      content: r.content.slice(0, 80),
      strength: r.strength,
      source: basename(r.source_file),
    })),
    weakest: weakest.map((r) => ({
      content: r.content.slice(0, 80),
      strength: r.strength,
      source: basename(r.source_file),
    })),
  };
}

// --- cli ---

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (!cmd) {
    console.log(
      "Usage: resonance <install|ingest|ingest-all|search|recall|random|report|stats|decay> [args]",
    );
    process.exit(0);
  }

  const config = loadConfig();

  if (cmd === "install") {
    await runInstall(config);
    return;
  }

  requireInstalled();
  const db = initDb(getDbPath(), config.embedding.dimensions);

  try {
    if (cmd === "ingest") {
      if (!args[1]) {
        console.log("Usage: resonance ingest <file>");
        process.exit(1);
      }
      const apiKey = getApiKey(config);
      const filePath = resolve(args[1]);
      if (!existsSync(filePath)) {
        console.error(`file not found: ${filePath}`);
        process.exit(1);
      }
      const count = await ingestFile(db, filePath, apiKey, config);
      const mode = apiKey ? "" : " (FTS only, no embeddings)";
      if (count < 0) {
        console.log(`removed ${-count} stale chunks from ${basename(filePath)}`);
      } else {
        console.log(`ingested ${count} new chunks from ${basename(filePath)}${mode}`);
      }
    } else if (cmd === "ingest-all") {
      const apiKey = getApiKey(config);
      const results = await ingestAll(db, apiKey, config);
      let added = 0;
      let removed = 0;
      for (const [path, count] of Object.entries(results)) {
        if (count > 0) console.log(`  ${basename(path)}: +${count} chunks`);
        else if (count < 0) console.log(`  ${basename(path)}: ${count} stale chunks removed`);
        if (count > 0) added += count;
        else removed += -count;
      }
      const mode = apiKey ? "" : " (FTS only, no embeddings)";
      const parts: string[] = [];
      if (added > 0) parts.push(`${added} new chunks ingested${mode}`);
      if (removed > 0) parts.push(`${removed} stale chunks removed`);
      console.log(`\n${parts.length > 0 ? parts.join(", ") : "no changes"}`);
    } else if (cmd === "search") {
      if (!args[1]) {
        console.log('Usage: resonance search "query" [--limit N] [--fts] [--vector]');
        process.exit(1);
      }
      const apiKey = getApiKey(config);
      const query = args[1];
      let limit = 5;
      const limitIdx = args.indexOf("--limit");
      if (limitIdx !== -1 && args[limitIdx + 1]) {
        limit = parseInt(args[limitIdx + 1], 10);
      }
      let searchMode: SearchMode = "hybrid";
      if (args.includes("--fts")) searchMode = "fts";
      else if (args.includes("--vector")) searchMode = "vector";

      const results = await search(db, query, apiKey, config, limit, 0.0, searchMode);
      if (results.length === 0) {
        const total = (db.prepare("SELECT COUNT(*) as c FROM memories").get() as { c: number }).c;
        if (total === 0) {
          console.log("no memories ingested yet. run ingest-all first.");
        } else {
          console.log("no resonant memories found for this query.");
        }
      }
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        const sourceShort = basename(r.sourceFile);
        const matchTag = searchMode === "hybrid" ? ` [${r.matchType}]` : "";
        console.log(
          `\n--- ${i + 1}. [id:${r.id}] ${sourceShort} (sim: ${r.similarity.toFixed(3)}, str: ${r.strength.toFixed(2)}, recalls: ${r.recallCount})${matchTag} ---`,
        );
        console.log(r.content.slice(0, 300));
      }
    } else if (cmd === "recall") {
      if (!args[1]) {
        console.log("Usage: resonance recall <id> [id2 id3 ...]");
        process.exit(1);
      }
      const ids = args
        .slice(1)
        .map((s) => parseInt(s, 10))
        .filter((n) => !Number.isNaN(n));
      recallMemories(db, ids, config);
      console.log(
        `recalled ${ids.length} memories (strength boosted by ${config.dynamics.resonanceBoost})`,
      );
    } else if (cmd === "random") {
      let limit = 5;
      let minStr = 0.0;
      let maxStr = 1.0;
      const limitIdx = args.indexOf("--limit");
      if (limitIdx !== -1 && args[limitIdx + 1]) {
        limit = parseInt(args[limitIdx + 1], 10);
      }
      const minIdx = args.indexOf("--min-strength");
      if (minIdx !== -1 && args[minIdx + 1]) {
        minStr = parseFloat(args[minIdx + 1]);
      }
      const maxIdx = args.indexOf("--max-strength");
      if (maxIdx !== -1 && args[maxIdx + 1]) {
        maxStr = parseFloat(args[maxIdx + 1]);
      }
      const results = randomMemories(db, limit, minStr, maxStr);
      if (results.length === 0) {
        console.log("no memories in the specified strength range.");
      }
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        const sourceShort = basename(r.sourceFile);
        console.log(
          `\n--- ${i + 1}. [id:${r.id}] ${sourceShort} (str: ${r.strength.toFixed(2)}, recalls: ${r.recallCount}) ---`,
        );
        console.log(r.content.slice(0, 300));
      }
    } else if (cmd === "report") {
      const apiKey = getApiKey(config);
      let against: string | undefined;
      const againstIdx = args.indexOf("--against");
      if (againstIdx !== -1 && args[againstIdx + 1]) {
        against = resolve(args[againstIdx + 1]);
      }
      const report = await resonanceReport(db, apiKey, config, against);
      console.log(report);
    } else if (cmd === "stats") {
      const s = getStats(db);
      const stats = s as {
        total_memories: number;
        by_type: Record<string, number>;
        avg_strength: number;
        most_recalled: Array<{ content: string; recalls: number; source: string }>;
        weakest: Array<{ content: string; strength: number; source: string }>;
      };
      console.log(`total memories: ${stats.total_memories}`);
      if (stats.total_memories === 0) {
        console.log("\nno memories yet. run ingest-all to populate from your memory files.");
      } else {
        console.log(`by type: ${JSON.stringify(stats.by_type)}`);
        console.log(`avg strength: ${stats.avg_strength}`);
      }
      if (stats.most_recalled.length > 0) {
        console.log("\nmost recalled:");
        for (const m of stats.most_recalled) {
          console.log(`  [${m.recalls}x] ${m.source}: ${m.content}`);
        }
      }
      if (stats.weakest.length > 0) {
        console.log("\nweakest (drifting):");
        for (const m of stats.weakest) {
          console.log(`  [str: ${m.strength.toFixed(2)}] ${m.source}: ${m.content}`);
        }
      }
    } else if (cmd === "decay") {
      const result = runDecay(db, config);
      console.log(`decay pass: ${result.decayed}/${result.total} memories decayed`);
    } else {
      console.error(`unknown command: ${cmd}`);
      process.exit(1);
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
    console.error(err);
    process.exit(1);
  });
}
