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
 *   resonance report [--against <file>]  # find cross-memory connections
 *   resonance stats                      # db statistics
 *   resonance decay                      # run decay pass
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

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
    boilerplatePatterns: string[];
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

function getApiKey(config: ResonanceConfig): string {
  const key = process.env[config.embedding.apiKeyEnvVar];
  if (!key) throw new Error(`${config.embedding.apiKeyEnvVar} not set`);
  return key;
}

// --- database ---

type Database = import("libsql").Database;

export function initDb(dbPath: string): Database {
  // Dynamic import to allow testing without libsql in some cases
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { DatabaseSync } = require("libsql");
  const db = new DatabaseSync(dbPath) as Database;
  db.exec("PRAGMA journal_mode=WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      source_file TEXT,
      source_type TEXT,
      chunk_index INTEGER DEFAULT 0,
      content_hash TEXT UNIQUE,
      embedding F32_BLOB(${1536}),
      strength REAL DEFAULT 1.0,
      recall_count INTEGER DEFAULT 0,
      last_recalled TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      metadata TEXT
    )
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_memories_source ON memories(source_file)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_memories_strength ON memories(strength DESC)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_memories_hash ON memories(content_hash)");
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

export function isBoilerplate(text: string, patterns: RegExp[]): boolean {
  if (patterns.length === 0) return false;
  const lines = text.trim().split("\n");
  if (lines.length === 0) return true;

  let boilerplateLines = 0;
  let contentLines = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (patterns.some((p) => p.test(trimmed))) {
      boilerplateLines++;
    } else {
      contentLines++;
    }
  }
  const total = boilerplateLines + contentLines;
  if (total === 0) return true;
  return boilerplateLines / total > 0.5;
}

export function stripBoilerplateLines(text: string, patterns: RegExp[]): string {
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
  boilerplateRe: RegExp[],
): Chunk[] {
  const sections = text.split(/^(##\s+.+)$/m);
  const chunks: Chunk[] = [];
  let currentHeader = "";

  for (let i = 0; i < sections.length; i++) {
    let part = sections[i].trim();
    if (part.startsWith("## ")) {
      currentHeader = part;
      continue;
    }
    if (!part) continue;

    // Strip boilerplate lines if patterns configured
    if (boilerplateRe.length > 0) {
      part = stripBoilerplateLines(part, boilerplateRe);
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
  const boilerplateRe = config.ingestion.boilerplatePatterns.map((p) => new RegExp(p, "m"));

  // Split on ## headers for all markdown files
  if (text.includes("\n## ")) {
    return chunkBySections(text, sourceFile, sourceType, config, boilerplateRe);
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
  apiKey: string,
  config: ResonanceConfig,
): Promise<number> {
  const text = readFileSync(filePath, "utf-8");
  const chunks = chunkText(text, filePath, config);
  if (chunks.length === 0) return 0;

  // Assign indices and hashes, filter already-ingested
  const checkStmt = db.prepare("SELECT id FROM memories WHERE content_hash = ?");
  const newChunks: Chunk[] = [];
  for (let i = 0; i < chunks.length; i++) {
    chunks[i].chunkIndex = i;
    chunks[i].contentHash = hashContent(chunks[i].content);
    const existing = checkStmt.get(chunks[i].contentHash) as { id: number } | undefined;
    if (!existing) newChunks.push(chunks[i]);
  }

  if (newChunks.length === 0) return 0;

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

    if (batchStart + batchSize < newChunks.length) {
      await new Promise((r) => setTimeout(r, 500)); // rate limiting
    }
  }

  return newChunks.length;
}

async function ingestAll(
  db: Database,
  apiKey: string,
  config: ResonanceConfig,
): Promise<Record<string, number>> {
  const home = getHomePath();
  const results: Record<string, number> = {};

  for (const file of config.ingestion.files) {
    const filePath = join(home, file);
    if (existsSync(filePath)) {
      results[file] = await ingestFile(db, filePath, apiKey, config);
    }
  }

  for (const dir of config.ingestion.dirs) {
    const dirPath = join(home, dir);
    if (!existsSync(dirPath)) continue;
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

async function search(
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
  const scored: SearchResult[] = rows.map((row) => {
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
    };
  });

  scored.sort((a, b) => b.weightedSimilarity - a.weightedSimilarity);
  const results = scored.slice(0, limit);

  // Boost recalled memories
  const now = new Date().toISOString().replace("T", " ").slice(0, 19);
  const updateStmt = db.prepare(
    `UPDATE memories
     SET recall_count = recall_count + 1,
         last_recalled = ?,
         strength = MIN(1.0, strength + ?)
     WHERE id = ?`,
  );
  for (const r of results) {
    updateStmt.run(now, config.dynamics.resonanceBoost, r.id);
  }

  return results;
}

function runDecay(db: Database, config: ResonanceConfig): { decayed: number; total: number } {
  const rows = db
    .prepare("SELECT id, strength, last_recalled, created_at FROM memories")
    .all() as Array<{
    id: number;
    strength: number;
    last_recalled: string | null;
    created_at: string;
  }>;

  const now = Date.now();
  const updateStmt = db.prepare("UPDATE memories SET strength = ? WHERE id = ?");
  let decayed = 0;

  for (const row of rows) {
    const last = row.last_recalled || row.created_at;
    if (!last) continue;
    const lastMs = new Date(last).getTime();
    if (Number.isNaN(lastMs)) continue;
    const daysSince = Math.floor((now - lastMs) / (1000 * 60 * 60 * 24));
    if (daysSince <= 0) continue;

    const newStrength = Math.max(
      config.dynamics.minStrength,
      row.strength - config.dynamics.decayRate * daysSince,
    );
    if (newStrength !== row.strength) {
      updateStmt.run(newStrength, row.id);
      decayed++;
    }
  }

  return { decayed, total: rows.length };
}

async function resonanceReport(
  db: Database,
  apiKey: string,
  config: ResonanceConfig,
  againstFile?: string,
): Promise<string> {
  let text: string;
  let source: string;

  if (againstFile) {
    const filePath = resolve(againstFile);
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
    console.log("Usage: resonance <ingest|ingest-all|search|report|stats|decay> [args]");
    process.exit(0);
  }

  const config = loadConfig();
  const db = initDb(getDbPath());

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
      console.log(`ingested ${count} new chunks from ${basename(filePath)}`);
    } else if (cmd === "ingest-all") {
      const apiKey = getApiKey(config);
      const results = await ingestAll(db, apiKey, config);
      let total = 0;
      for (const [path, count] of Object.entries(results)) {
        if (count > 0) console.log(`  ${basename(path)}: ${count} chunks`);
        total += count;
      }
      console.log(`\ntotal: ${total} new chunks ingested`);
    } else if (cmd === "search") {
      if (!args[1]) {
        console.log('Usage: resonance search "query" [--limit N]');
        process.exit(1);
      }
      const apiKey = getApiKey(config);
      const query = args[1];
      let limit = 5;
      const limitIdx = args.indexOf("--limit");
      if (limitIdx !== -1 && args[limitIdx + 1]) {
        limit = parseInt(args[limitIdx + 1], 10);
      }
      const results = await search(db, query, apiKey, config, limit);
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
        console.log(
          `\n--- ${i + 1}. ${sourceShort} (sim: ${r.similarity.toFixed(3)}, str: ${r.strength.toFixed(2)}, recalls: ${r.recallCount}) ---`,
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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
