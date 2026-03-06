import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

// Import the resonance module functions we want to test
// The script uses `require("libsql")` at runtime; we import directly for DB tests
import {
  chunkByWords,
  chunkText,
  detectSourceType,
  initDb,
  isBoilerplate,
  loadConfig,
  stripBoilerplateLines,
} from "../skills/resonance/scripts/resonance.js";

describe("resonance", () => {
  describe("detectSourceType", () => {
    it("detects journal files", () => {
      assert.equal(detectSourceType("memory/journal/2026-03-06.md"), "journal");
    });

    it("detects reading files", () => {
      assert.equal(detectSourceType("memory/reading/notes.md"), "reading");
    });

    it("detects topic files", () => {
      assert.equal(detectSourceType("memory/topics/philosophy.md"), "topic");
    });

    it("detects MEMORY.md", () => {
      assert.equal(detectSourceType("MEMORY.md"), "memory");
    });

    it("defaults to other", () => {
      assert.equal(detectSourceType("random.md"), "other");
    });
  });

  describe("isBoilerplate", () => {
    it("returns false with no patterns", () => {
      assert.equal(isBoilerplate("some text", []), false);
    });

    it("returns true when majority matches patterns", () => {
      const patterns = [/^- \*\*Camera:\*\*/];
      const text = "- **Camera:** front yard\n- **Camera:** back yard\none real line";
      assert.equal(isBoilerplate(text, patterns), true);
    });

    it("returns false when minority matches patterns", () => {
      const patterns = [/^- \*\*Camera:\*\*/];
      const text = "real line one\nreal line two\n- **Camera:** front yard";
      assert.equal(isBoilerplate(text, patterns), false);
    });

    it("returns true for empty text", () => {
      assert.equal(isBoilerplate("", []), true);
    });
  });

  describe("stripBoilerplateLines", () => {
    it("removes matching lines", () => {
      const patterns = [/^- \*\*Camera:\*\*/];
      const text = "real line\n- **Camera:** front yard\nanother real line";
      assert.equal(stripBoilerplateLines(text, patterns), "real line\nanother real line");
    });

    it("returns unchanged with no patterns", () => {
      const text = "line one\nline two";
      assert.equal(stripBoilerplateLines(text, []), text);
    });
  });

  describe("chunkByWords", () => {
    it("returns single chunk for short text", () => {
      const chunks = chunkByWords("hello world foo bar", "test.md", "other", 512, 64);
      assert.equal(chunks.length, 1);
      assert.equal(chunks[0].content, "hello world foo bar");
    });

    it("splits long text into overlapping chunks", () => {
      const words = Array.from({ length: 100 }, (_, i) => `word${i}`);
      const text = words.join(" ");
      const chunks = chunkByWords(text, "test.md", "other", 30, 5);
      assert(chunks.length > 1);
      // Check overlap: end of first chunk should overlap with start of second
      const firstWords = chunks[0].content.split(" ");
      const secondWords = chunks[1].content.split(" ");
      // Last 5 words of first chunk should be first 5 words of second chunk
      assert.deepEqual(firstWords.slice(-5), secondWords.slice(0, 5));
    });
  });

  describe("chunkText", () => {
    const config = {
      embedding: {
        provider: "openrouter",
        url: "https://openrouter.ai/api/v1/embeddings",
        model: "openai/text-embedding-3-small",
        dimensions: 1536,
        apiKeyEnvVar: "OPENROUTER_API_KEY",
      },
      ingestion: {
        dirs: ["memory/journal"],
        files: ["MEMORY.md"],
        chunkSize: 512,
        chunkOverlap: 64,
        boilerplatePatterns: [],
      },
      dynamics: { decayRate: 0.02, minStrength: 0.1, resonanceBoost: 0.05 },
    };

    it("returns empty for empty text", () => {
      assert.deepEqual(chunkText("", "test.md", config), []);
    });

    it("returns empty for trivially short text", () => {
      assert.deepEqual(chunkText("too short", "test.md", config), []);
    });

    it("splits on ## headers", () => {
      const text = [
        "# Title",
        "",
        "## Section One",
        "",
        Array.from({ length: 20 }, (_, i) => `word${i}`).join(" "),
        "",
        "## Section Two",
        "",
        Array.from({ length: 20 }, (_, i) => `other${i}`).join(" "),
      ].join("\n");

      const chunks = chunkText(text, "memory/journal/2026-03-06.md", config);
      assert(chunks.length >= 2);
      assert(chunks[0].content.includes("Section One"));
      assert(chunks[1].content.includes("Section Two"));
      assert.equal(chunks[0].sourceType, "journal");
    });

    it("skips sections shorter than 15 words", () => {
      const text = [
        "## Short Section",
        "",
        "tiny",
        "",
        "## Long Section",
        "",
        Array.from({ length: 20 }, (_, i) => `word${i}`).join(" "),
      ].join("\n");

      const chunks = chunkText(text, "test.md", config);
      assert.equal(chunks.length, 1);
      assert(chunks[0].content.includes("Long Section"));
    });

    it("filters boilerplate when patterns configured", () => {
      const configWithPatterns = {
        ...config,
        ingestion: {
          ...config.ingestion,
          boilerplatePatterns: ["^- \\*\\*Camera:\\*\\*"],
        },
      };

      const text = [
        "## Heartbeat",
        "",
        "- **Camera:** front yard view",
        "- **Camera:** back yard view",
        "- **Camera:** side view",
        "",
        "## Real Content",
        "",
        Array.from({ length: 20 }, (_, i) => `meaningful${i}`).join(" "),
      ].join("\n");

      const chunks = chunkText(text, "memory/journal/test.md", configWithPatterns);
      // Heartbeat section should be filtered (all boilerplate)
      assert(chunks.every((c) => !c.content.includes("Camera")));
      assert(chunks.some((c) => c.content.includes("meaningful")));
    });

    it("uses word chunking for text without ## headers", () => {
      const words = Array.from({ length: 30 }, (_, i) => `word${i}`);
      const text = words.join(" ");
      const chunks = chunkText(text, "test.md", config);
      assert.equal(chunks.length, 1);
      assert.equal(chunks[0].sourceType, "other");
    });
  });

  describe("loadConfig", () => {
    const origMindDir = process.env.VOLUTE_MIND_DIR;

    after(() => {
      if (origMindDir) process.env.VOLUTE_MIND_DIR = origMindDir;
      else delete process.env.VOLUTE_MIND_DIR;
    });

    it("returns default config when no VOLUTE_MIND_DIR", () => {
      delete process.env.VOLUTE_MIND_DIR;
      const config = loadConfig();
      assert.equal(config.embedding.model, "openai/text-embedding-3-small");
      assert.equal(config.ingestion.chunkSize, 512);
      assert.equal(config.dynamics.decayRate, 0.02);
    });

    it("merges override config", () => {
      const tmpDir = join(tmpdir(), `resonance-test-config-${process.pid}`);
      const configDir = join(tmpDir, "home", ".config");
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        join(configDir, "resonance.json"),
        JSON.stringify({
          ingestion: { chunkSize: 256 },
          dynamics: { decayRate: 0.05 },
        }),
      );
      process.env.VOLUTE_MIND_DIR = tmpDir;
      const config = loadConfig();
      assert.equal(config.ingestion.chunkSize, 256);
      assert.equal(config.dynamics.decayRate, 0.05);
      // Defaults preserved for non-overridden fields
      assert.equal(config.embedding.model, "openai/text-embedding-3-small");
      assert.equal(config.ingestion.chunkOverlap, 64);
    });
  });

  describe("database", () => {
    let dbPath: string;
    let db: ReturnType<typeof initDb>;

    before(() => {
      dbPath = join(tmpdir(), `resonance-test-db-${process.pid}-${Date.now()}.db`);
      db = initDb(dbPath);
    });

    after(() => {
      db.close();
    });

    it("creates schema", () => {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memories'")
        .all() as Array<{ name: string }>;
      assert.equal(tables.length, 1);
    });

    it("inserts and queries memories", () => {
      // Insert a memory with a vector
      const vec = Array.from({ length: 1536 }, () => Math.random());
      const vecJson = JSON.stringify(vec);

      db.prepare(
        `INSERT INTO memories (content, source_file, source_type, chunk_index, content_hash, embedding, metadata)
         VALUES (?, ?, ?, ?, ?, vector(?), ?)`,
      ).run("test memory content", "test.md", "other", 0, "abc123", vecJson, "{}");

      const rows = db
        .prepare("SELECT * FROM memories WHERE content_hash = ?")
        .all("abc123") as Array<{
        id: number;
        content: string;
      }>;
      assert.equal(rows.length, 1);
      assert.equal(rows[0].content, "test memory content");
    });

    it("enforces unique content_hash", () => {
      const vec = Array.from({ length: 1536 }, () => Math.random());
      const vecJson = JSON.stringify(vec);

      db.prepare(
        `INSERT OR IGNORE INTO memories (content, source_file, source_type, chunk_index, content_hash, embedding, metadata)
         VALUES (?, ?, ?, ?, ?, vector(?), ?)`,
      ).run("duplicate test", "test.md", "other", 0, "dup123", vecJson, "{}");

      db.prepare(
        `INSERT OR IGNORE INTO memories (content, source_file, source_type, chunk_index, content_hash, embedding, metadata)
         VALUES (?, ?, ?, ?, ?, vector(?), ?)`,
      ).run("duplicate test 2", "test.md", "other", 0, "dup123", vecJson, "{}");

      const rows = db
        .prepare("SELECT * FROM memories WHERE content_hash = ?")
        .all("dup123") as Array<{ content: string }>;
      assert.equal(rows.length, 1);
      assert.equal(rows[0].content, "duplicate test");
    });

    it("computes vector_distance_cos", () => {
      // Insert two vectors: one identical pair, one different
      const vecA = Array.from({ length: 1536 }, () => 0.5);
      const vecB = Array.from({ length: 1536 }, (_, i) => (i < 768 ? 1.0 : 0.0));

      db.prepare(
        `INSERT INTO memories (content, source_file, source_type, chunk_index, content_hash, embedding, metadata)
         VALUES (?, ?, ?, ?, ?, vector(?), ?)`,
      ).run("vec a", "test.md", "other", 0, "veca", JSON.stringify(vecA), "{}");

      db.prepare(
        `INSERT INTO memories (content, source_file, source_type, chunk_index, content_hash, embedding, metadata)
         VALUES (?, ?, ?, ?, ?, vector(?), ?)`,
      ).run("vec b", "test.md", "other", 0, "vecb", JSON.stringify(vecB), "{}");

      // Search with vecA — should find itself as closest
      const results = db
        .prepare(
          `SELECT content, vector_distance_cos(embedding, vector(?)) AS distance
           FROM memories
           WHERE content_hash IN ('veca', 'vecb')
           ORDER BY distance ASC`,
        )
        .all(JSON.stringify(vecA)) as Array<{ content: string; distance: number }>;

      assert.equal(results.length, 2);
      assert.equal(results[0].content, "vec a");
      assert(results[0].distance < results[1].distance);
    });
  });
});
