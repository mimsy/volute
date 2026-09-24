import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";

import {
  chunkByWords,
  chunkText,
  cleanPrompt,
  detectSourceType,
  ensureEmbeddingSchema,
  formatSurfaced,
  initDb,
  isMostlyIgnored,
  loadConfig,
  maybeDecay,
  minMatchedTerms,
  parseDbTimestamp,
  queryTerms,
  type ResonanceConfig,
  runDecay,
  runHook,
  searchFts,
  stripIgnoredLines,
  surface,
  syncFiles,
  toDbTimestamp,
} from "../skills/resonance/scripts/resonance.js";

const REPO = resolve(import.meta.dirname, "..");
const SKILL_DIR = join(REPO, "skills", "resonance");

const words = (prefix: string, n: number) =>
  Array.from({ length: n }, (_, i) => `${prefix}${i}`).join(" ");

const WALK =
  "## Walk\n\nWalked the river path with Alice and watched the heron fishing in the shallows for a long quiet while.";

function testConfig(): ResonanceConfig {
  return {
    recall: "auto",
    embedding: null,
    ingestion: {
      dirs: ["memory/journal", "memory/dreams", "memory/topics"],
      files: ["MEMORY.md"],
      chunkSize: 512,
      chunkOverlap: 64,
      ignorePatterns: [],
    },
    dynamics: { decayRate: 0.02, minStrength: 0.1, resonanceBoost: 0.05, surfaceBoost: 0.02 },
  };
}

/** A throwaway mind dir with VOLUTE_MIND_DIR pointed at it for the duration of each test. */
function useMind() {
  const origMindDir = process.env.VOLUTE_MIND_DIR;
  const state: { dir: string; home: string } = { dir: "", home: "" };
  beforeEach(() => {
    state.dir = mkdtempSync(join(tmpdir(), "resonance-mind-"));
    state.home = join(state.dir, "home");
    mkdirSync(join(state.home, "memory", "journal"), { recursive: true });
    process.env.VOLUTE_MIND_DIR = state.dir;
  });
  afterEach(() => {
    if (origMindDir) process.env.VOLUTE_MIND_DIR = origMindDir;
    else delete process.env.VOLUTE_MIND_DIR;
    rmSync(state.dir, { recursive: true, force: true });
  });
  return state;
}

function write(home: string, rel: string, text: string) {
  const path = join(home, rel);
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, text);
  return path;
}

/** Move a file's mtime so the incremental sync sees an edit even within one clock tick. */
function touchLater(path: string, seconds: number) {
  const t = new Date(Date.now() + seconds * 1000);
  utimesSync(path, t, t);
}

function openDb(dir: string) {
  return initDb(join(dir, ".mind-resonance.db"));
}

const count = (db: ReturnType<typeof openDb>, sql: string) =>
  (db.prepare(sql).get() as { c: number }).c;

describe("resonance", () => {
  describe("detectSourceType", () => {
    it("classifies paths relative to home", () => {
      assert.equal(detectSourceType("memory/journal/2026-03-06.md"), "journal");
      assert.equal(detectSourceType("memory/dreams/2026-03-06.md"), "dream");
      assert.equal(detectSourceType("memory/topics/philosophy.md"), "topic");
      assert.equal(detectSourceType("MEMORY.md"), "memory");
      assert.equal(detectSourceType("random.md"), "other");
    });

    it("matches on the path's own place, not a word anywhere in it", () => {
      // Matching against the whole absolute path classified e.g. every file under a
      // directory named "journal" — or a topic called "journal habits" — as journal.
      assert.equal(detectSourceType("memory/topics/my-journal-habits.md"), "topic");
      assert.equal(detectSourceType("notes/journal/x.md"), "other");
    });
  });

  describe("isMostlyIgnored / stripIgnoredLines", () => {
    it("returns false with no patterns", () => {
      assert.equal(isMostlyIgnored("some text", []), false);
    });

    it("returns true when majority matches patterns", () => {
      const patterns = [/^- \*\*Camera:\*\*/];
      const text = "- **Camera:** front yard\n- **Camera:** back yard\none real line";
      assert.equal(isMostlyIgnored(text, patterns), true);
    });

    it("removes matching lines", () => {
      const patterns = [/^- \*\*Camera:\*\*/];
      const text = "real line\n- **Camera:** front yard\nanother real line";
      assert.equal(stripIgnoredLines(text, patterns), "real line\nanother real line");
    });
  });

  describe("chunking", () => {
    const config = testConfig();

    it("chunkByWords splits long text into overlapping, numbered chunks", () => {
      const chunks = chunkByWords(words("word", 100), "test.md", "other", 30, 5);
      assert(chunks.length > 1);
      assert.deepEqual(
        chunks[0].content.split(" ").slice(-5),
        chunks[1].content.split(" ").slice(0, 5),
      );
      assert.deepEqual(
        chunks.map((c) => c.chunkIndex),
        chunks.map((_, i) => i),
      );
    });

    it("returns nothing for empty or trivially short text", () => {
      assert.deepEqual(chunkText("", "test.md", config), []);
      assert.deepEqual(chunkText("too short", "test.md", config), []);
    });

    it("splits on any heading level and records section + occurrence", () => {
      const text = [
        "# Top",
        words("intro", 20),
        "## Notes",
        words("first", 20),
        "## Notes",
        words("second", 20),
        "## Tiny",
        "too short",
      ].join("\n\n");
      const chunks = chunkText(text, "memory/journal/2026-03-06.md", config);
      assert.deepEqual(
        chunks.map((c) => [c.section, c.sectionIndex]),
        [
          ["# Top", 0],
          ["## Notes", 0],
          ["## Notes", 1],
        ],
      );
      assert.equal(chunks[0].sourceType, "journal");
      assert.ok(chunks.every((c) => c.contentHash.length === 16));
    });

    it("filters ignored lines when patterns configured", () => {
      const cfg = testConfig();
      cfg.ingestion.ignorePatterns = ["^- \\*\\*Camera:\\*\\*"];
      const text = [
        "## Heartbeat",
        "- **Camera:** front yard view\n- **Camera:** back yard view\n- **Camera:** side view",
        "## Real Content",
        words("meaningful", 20),
      ].join("\n\n");
      const chunks = chunkText(text, "memory/journal/test.md", cfg);
      assert(chunks.every((c) => !c.content.includes("Camera")));
      assert(chunks.some((c) => c.content.includes("meaningful")));
    });
  });

  describe("loadConfig", () => {
    const mind = useMind();

    it("defaults: recall auto, embeddings off, dreams in, reading out", () => {
      const config = loadConfig();
      assert.equal(config.recall, "auto");
      assert.equal(config.embedding, null);
      assert.deepEqual(config.ingestion.dirs, ["memory/journal", "memory/dreams", "memory/topics"]);
    });

    it("reads recall from memory.recall in config.json, engine settings from resonance.json", () => {
      write(
        mind.home,
        ".config/config.json",
        JSON.stringify({ model: "x", memory: { recall: "on-demand" } }),
      );
      write(mind.home, ".config/resonance.json", JSON.stringify({ ingestion: { chunkSize: 256 } }));
      const config = loadConfig();
      assert.equal(config.recall, "on-demand");
      assert.equal(config.ingestion.chunkSize, 256);
      assert.equal(config.ingestion.chunkOverlap, 64);

      write(mind.home, ".config/config.json", JSON.stringify({ memory: { recall: "sometimes" } }));
      assert.throws(() => loadConfig(), /"memory.recall" must be one of/);
      write(mind.home, ".config/config.json", "{}");
      write(mind.home, ".config/resonance.json", JSON.stringify({ embedding: { url: "x" } }));
      assert.throws(() => loadConfig(), /"embedding" needs/);
    });
  });

  describe("config validation", () => {
    const mind = useMind();

    it("refuses a chunkOverlap that would never let the chunker advance", () => {
      for (const ingestion of [
        { chunkSize: 10, chunkOverlap: 10 },
        { chunkSize: 10, chunkOverlap: 20 },
        { chunkSize: 0 },
        { chunkSize: 1.5 },
        { dirs: "memory" },
      ]) {
        write(mind.home, ".config/resonance.json", JSON.stringify({ ingestion }));
        assert.throws(() => loadConfig(), /Invalid resonance\.json/, JSON.stringify(ingestion));
      }
      write(mind.home, ".config/resonance.json", JSON.stringify({ dynamics: { decayRate: "x" } }));
      assert.throws(() => loadConfig(), /dynamics\.decayRate/);
    });

    it("the chunker itself always advances", () => {
      const chunks = chunkByWords(words("w", 50), "t.md", "other", 10, 10);
      assert.ok(chunks.length > 0 && chunks.length <= 50);
    });

    it("drops an invalid ignore pattern with a warning instead of failing", () => {
      write(
        mind.home,
        ".config/resonance.json",
        JSON.stringify({ ingestion: { ignorePatterns: ["^ok", "(unclosed"] } }),
      );
      const config = loadConfig();
      assert.deepEqual(config.ingestion.ignorePatterns, ["^ok"]);
      assert.match(config.warnings?.[0] ?? "", /\(unclosed/);
    });
  });

  describe("schema", () => {
    const mind = useMind();

    it("waits for a lock rather than failing when the hook and a command overlap", () => {
      const db = openDb(mind.dir);
      try {
        const row = db.prepare("PRAGMA busy_timeout").get() as { timeout: number };
        assert.equal(row.timeout, 5000);
      } finally {
        db.close();
      }
    });

    it("does not index file paths as searchable text", () => {
      const db = openDb(mind.dir);
      try {
        db.prepare(
          "INSERT INTO memories (content, source_file, source_type, content_hash) VALUES (?, ?, ?, ?)",
        ).run(words("plain", 20), "memory/journal/volute-lighthouse.md", "journal", "h1");
        assert.equal(searchFts(db, "lighthouse").length, 0);
        assert.equal(searchFts(db, "plain3").length, 1);
      } finally {
        db.close();
      }
    });

    it("rebuilds a database from the old layout instead of failing on it", () => {
      const Database = createRequire(import.meta.url)("libsql");
      const path = join(mind.dir, ".mind-resonance.db");
      const old = new Database(path);
      old.exec(
        "CREATE TABLE memories (id INTEGER PRIMARY KEY, content TEXT, source_file TEXT, content_hash TEXT UNIQUE)",
      );
      old.exec(
        "INSERT INTO memories (content, source_file, content_hash) VALUES ('x', '/abs/x.md', 'h')",
      );
      old.close();

      const db = initDb(path);
      try {
        const cols = (
          db.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>
        ).map((c) => c.name);
        assert.ok(cols.includes("surfaced_count"));
        assert.equal(count(db, "SELECT COUNT(*) AS c FROM memories"), 0);
      } finally {
        db.close();
      }
    });

    it("carries strength and recall history across from the old layout", () => {
      const Database = createRequire(import.meta.url)("libsql");
      const path = join(mind.dir, ".mind-resonance.db");
      const old = new Database(path);
      old.exec(
        `CREATE TABLE memories (id INTEGER PRIMARY KEY, content TEXT, source_file TEXT,
           source_type TEXT, chunk_index INTEGER, content_hash TEXT UNIQUE, strength REAL,
           recall_count INTEGER, last_recalled TEXT, last_decayed TEXT, created_at TEXT, metadata TEXT)`,
      );
      old
        .prepare(
          "INSERT INTO memories (content, source_file, content_hash, strength, recall_count, last_recalled, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          "old text",
          "/somewhere/else/minds/x/home/memory/topics/t.md",
          "h",
          0.4,
          3,
          "2026-09-01 00:00:00",
          JSON.stringify({ section: "## Two" }),
        );
      old.close();

      write(
        mind.home,
        "memory/topics/t.md",
        `## One\n\n${words("alpha", 20)}\n\n## Two\n\n${words("beta", 20)}`,
      );
      const db = initDb(path);
      try {
        syncFiles(db, testConfig());
        const two = db
          .prepare(
            "SELECT strength, recall_count, last_recalled FROM memories WHERE section = '## Two'",
          )
          .get() as { strength: number; recall_count: number; last_recalled: string };
        assert.equal(two.strength, 0.4);
        assert.equal(two.recall_count, 3);
        assert.equal(two.last_recalled, "2026-09-01 00:00:00");
        const one = db.prepare("SELECT strength FROM memories WHERE section = '## One'").get() as {
          strength: number;
        };
        assert.equal(one.strength, 1, "sections with no history start fresh");
        assert.equal(count(db, "SELECT COUNT(*) AS c FROM carried"), 0);
      } finally {
        db.close();
      }
    });

    it("recreates embeddings when the model's dimensions change, keeping the memories", () => {
      const db = openDb(mind.dir);
      try {
        db.prepare(
          "INSERT INTO memories (content, source_file, source_type, content_hash) VALUES ('m', 'a.md', 'other', 'h')",
        ).run();
        const emb = { url: "http://x", model: "m1", dimensions: 3, apiKeyEnvVar: "K" };
        ensureEmbeddingSchema(db, emb);
        db.prepare(
          "INSERT INTO embeddings (memory_id, embedding) VALUES (1, vector('[1,0,0]'))",
        ).run();
        const dist = db
          .prepare("SELECT vector_distance_cos(embedding, vector('[1,0,0]')) AS d FROM embeddings")
          .get() as { d: number };
        assert.ok(Math.abs(dist.d) < 1e-6);

        ensureEmbeddingSchema(db, { ...emb, dimensions: 4 });
        assert.equal(count(db, "SELECT COUNT(*) AS c FROM embeddings"), 0);
        assert.equal(count(db, "SELECT COUNT(*) AS c FROM memories"), 1);
        db.prepare(
          "INSERT INTO embeddings (memory_id, embedding) VALUES (1, vector('[1,0,0,0]'))",
        ).run();

        // An edit makes the vector stale; a delete takes it along.
        db.prepare("UPDATE memories SET content = 'edited' WHERE id = 1").run();
        assert.equal(count(db, "SELECT COUNT(*) AS c FROM embeddings"), 0);
        db.prepare(
          "INSERT INTO embeddings (memory_id, embedding) VALUES (1, vector('[1,0,0,0]'))",
        ).run();
        db.prepare("DELETE FROM memories").run();
        assert.equal(count(db, "SELECT COUNT(*) AS c FROM embeddings"), 0);
      } finally {
        db.close();
      }
    });
  });

  describe("syncFiles", () => {
    const mind = useMind();
    const config = testConfig();

    it("stores paths relative to home and indexes dreams", () => {
      write(mind.home, "memory/journal/2026-09-01.md", `## Walk\n\n${words("river", 20)}`);
      write(mind.home, "memory/dreams/2026-09-02.md", `## Dream\n\n${words("tide", 20)}`);
      const db = openDb(mind.dir);
      try {
        assert.equal(syncFiles(db, config).indexed, 2);
        const rows = db
          .prepare("SELECT source_file, source_type FROM memories ORDER BY source_file")
          .all() as Array<{ source_file: string; source_type: string }>;
        assert.deepEqual(
          rows.map((x) => [x.source_file, x.source_type]),
          [
            ["memory/dreams/2026-09-02.md", "dream"],
            ["memory/journal/2026-09-01.md", "journal"],
          ],
        );
        assert.equal(syncFiles(db, config).indexed, 0, "unchanged files are not re-read");
      } finally {
        db.close();
      }
    });

    it("drops everything from a deleted file", () => {
      const path = write(mind.home, "memory/journal/a.md", `## A\n\n${words("gone", 20)}`);
      const db = openDb(mind.dir);
      try {
        syncFiles(db, config);
        assert.equal(searchFts(db, "gone3").length, 1);
        unlinkSync(path);
        assert.equal(syncFiles(db, config).removed, 1);
        assert.equal(searchFts(db, "gone3").length, 0);
        assert.equal(count(db, "SELECT COUNT(*) AS c FROM indexed_files"), 0);
      } finally {
        db.close();
      }
    });

    it("keeps the same text in two files as two memories", () => {
      const text = `## Shared\n\n${words("same", 20)}`;
      write(mind.home, "memory/journal/a.md", text);
      const b = write(mind.home, "memory/topics/b.md", text);
      const db = openDb(mind.dir);
      try {
        syncFiles(db, config);
        assert.equal(searchFts(db, "same3").length, 2);
        // Removing one copy must not take the other with it.
        unlinkSync(b);
        syncFiles(db, config);
        const rows = searchFts(db, "same3");
        assert.equal(rows.length, 1);
        assert.equal(rows[0].sourceFile, "memory/journal/a.md");
      } finally {
        db.close();
      }
    });

    it("carries strength and history across an edit to a section", () => {
      const path = write(
        mind.home,
        "memory/topics/t.md",
        `## One\n\n${words("alpha", 20)}\n\n## Two\n\n${words("beta", 20)}`,
      );
      const db = openDb(mind.dir);
      try {
        syncFiles(db, config);
        const before = db.prepare("SELECT id FROM memories WHERE section = '## Two'").get() as {
          id: number;
        };
        db.prepare(
          "UPDATE memories SET strength = 0.4, recall_count = 3, surfaced_count = 2 WHERE id = ?",
        ).run(before.id);

        writeFileSync(path, `## One\n\n${words("alpha", 20)}\n\n## Two\n\n${words("gamma", 20)}`);
        touchLater(path, 5);
        assert.equal(syncFiles(db, config).indexed, 1);

        const edited = db
          .prepare(
            "SELECT id, content, strength, recall_count, surfaced_count FROM memories WHERE section = '## Two'",
          )
          .get() as {
          id: number;
          content: string;
          strength: number;
          recall_count: number;
          surfaced_count: number;
        };
        assert.equal(edited.id, before.id);
        assert.ok(edited.content.includes("gamma3"));
        assert.equal(edited.strength, 0.4);
        assert.equal(edited.recall_count, 3);
        assert.equal(edited.surfaced_count, 2);
        assert.equal(searchFts(db, "beta3").length, 0, "old text must leave the index");
        assert.equal(searchFts(db, "gamma3").length, 1);
      } finally {
        db.close();
      }
    });

    it("stores duplicated text within one file once, including newly added duplicates", () => {
      const path = write(mind.home, "memory/topics/d.md", `## X\n\n${words("dup", 20)}`);
      const db = openDb(mind.dir);
      try {
        syncFiles(db, config);
        const x = `## X\n\n${words("dup", 20)}`;
        const y = `## Y\n\n${words("new", 20)}`;
        writeFileSync(path, [x, x, y, y].join("\n\n"));
        touchLater(path, 5);
        syncFiles(db, config);
        assert.equal(count(db, "SELECT COUNT(*) AS c FROM memories"), 2);
      } finally {
        db.close();
      }
    });

    it("caps files per call so a backlog catches up over several turns", () => {
      for (let i = 0; i < 5; i++) {
        write(mind.home, `memory/journal/${i}.md`, `## D\n\n${words(`day${i}x`, 20)}`);
      }
      const db = openDb(mind.dir);
      try {
        assert.deepEqual(syncFiles(db, config, 2), { indexed: 2, removed: 0, pending: 3 });
        assert.deepEqual(syncFiles(db, config, 2), { indexed: 2, removed: 0, pending: 1 });
        assert.deepEqual(syncFiles(db, config, 2), { indexed: 1, removed: 0, pending: 0 });
      } finally {
        db.close();
      }
    });

    it("stops when its time budget is spent, having made some progress", () => {
      for (let i = 0; i < 3; i++) {
        write(mind.home, `memory/journal/${i}.md`, `## D\n\n${words(`t${i}x`, 20)}`);
      }
      const db = openDb(mind.dir);
      try {
        assert.deepEqual(syncFiles(db, config, Infinity, 0), {
          indexed: 1,
          removed: 0,
          pending: 2,
        });
        assert.deepEqual(syncFiles(db, config, Infinity, 0), {
          indexed: 1,
          removed: 0,
          pending: 1,
        });
      } finally {
        db.close();
      }
    });

    it("is quiet about configured dirs that don't exist", () => {
      const db = openDb(mind.dir);
      try {
        assert.deepEqual(syncFiles(db, config), { indexed: 0, removed: 0, pending: 0 });
      } finally {
        db.close();
      }
    });
  });

  describe("decay", () => {
    const mind = useMind();
    const config = testConfig();
    const origTz = process.env.TZ;
    after(() => {
      if (origTz === undefined) delete process.env.TZ;
      else process.env.TZ = origTz;
    });

    function insertAt(db: ReturnType<typeof openDb>, createdAt: string, hash: string) {
      db.prepare(
        "INSERT INTO memories (content, source_file, source_type, content_hash, created_at) VALUES ('c', 'f.md', 'other', ?, ?)",
      ).run(hash, createdAt);
      return (
        db.prepare("SELECT id FROM memories WHERE content_hash = ?").get(hash) as { id: number }
      ).id;
    }
    const strength = (db: ReturnType<typeof openDb>, id: number) =>
      (db.prepare("SELECT strength FROM memories WHERE id = ?").get(id) as { strength: number })
        .strength;

    for (const tz of ["UTC", "America/Los_Angeles", "Pacific/Kiritimati"]) {
      it(`decays by the exact elapsed time in ${tz}`, () => {
        process.env.TZ = tz;
        const db = openDb(mind.dir);
        try {
          const id = insertAt(db, "2026-09-22 00:00:00", `h-${tz}`); // 1.5 days before, UTC
          runDecay(db, config, new Date("2026-09-23T12:00:00Z"));
          assert.ok(Math.abs(strength(db, id) - 0.97) < 1e-9, `got ${strength(db, id)}`);
        } finally {
          db.close();
        }
      });
    }

    it("reads the rows it decays inside its write transaction", () => {
      const db = openDb(mind.dir);
      try {
        insertAt(db, "2026-09-01 00:00:00", "h");
        const seen: boolean[] = [];
        const spy = new Proxy(db, {
          get(target, prop) {
            if (prop === "prepare") {
              return (sql: string) => {
                if (/^SELECT id, strength/.test(sql.trim())) seen.push(target.inTransaction);
                return target.prepare(sql);
              };
            }
            const v = Reflect.get(target, prop);
            return typeof v === "function" ? v.bind(target) : v;
          },
        });
        runDecay(spy, config, new Date("2026-09-10T00:00:00Z"));
        assert.deepEqual(seen, [true]);
      } finally {
        db.close();
      }
    });

    it("keeps fractional days across runs and lets a recall restart the clock", () => {
      const db = openDb(mind.dir);
      try {
        const id = insertAt(db, "2026-09-20 00:00:00", "h");
        runDecay(db, config, new Date("2026-09-20T12:00:00Z"));
        runDecay(db, config, new Date("2026-09-21T00:00:00Z"));
        assert.ok(Math.abs(strength(db, id) - 0.98) < 1e-9, "two half-days make a day");

        db.prepare("UPDATE memories SET last_recalled = '2026-09-22 00:00:00' WHERE id = ?").run(
          id,
        );
        runDecay(db, config, new Date("2026-09-22T12:00:00Z"));
        assert.ok(Math.abs(strength(db, id) - 0.97) < 1e-9, "only the half-day since the recall");
      } finally {
        db.close();
      }
    });

    it("runs lazily, at most once a day, starting the clock on first use", () => {
      const db = openDb(mind.dir);
      try {
        const id = insertAt(db, "2026-09-01 00:00:00", "h");
        assert.equal(maybeDecay(db, config, new Date("2026-09-10T00:00:00Z")), null);
        assert.equal(strength(db, id), 1);
        assert.equal(maybeDecay(db, config, new Date("2026-09-10T20:00:00Z")), null);
        assert.deepEqual(maybeDecay(db, config, new Date("2026-09-11T01:00:00Z")), {
          decayed: 1,
          total: 1,
        });
        assert.ok(strength(db, id) < 1);
      } finally {
        db.close();
      }
    });

    it("parses zone-less DB timestamps as UTC", () => {
      process.env.TZ = "America/New_York";
      assert.equal(parseDbTimestamp("2026-01-01 00:00:00"), Date.UTC(2026, 0, 1));
      assert.equal(toDbTimestamp(new Date(Date.UTC(2026, 0, 1, 5))), "2026-01-01 05:00:00");
    });
  });

  describe("query cleaning", () => {
    it("drops message prefixes, cards, typing notes and system-event blocks", () => {
      const prompt = [
        "=== System event: heartbeat — 2026-09-23 10:00 ===",
        "Take a moment. What's alive for you?",
        "[Volute: alice in DM — 2026-09-23 10:01]",
        "[Participants:",
        "  alice (Alice) [human] — loves herons",
        "]",
        "[#garden — for garden talk",
        "  Rules: be kind]",
        "did the heron come back?",
        "[bob is typing]",
      ].join("\n");
      assert.equal(cleanPrompt(prompt), "did the heron come back?");
    });

    it("skips a participant card whose lines end in their own brackets", () => {
      const prompt = [
        "[Volute: alice in DM — 2026-09-23 10:01]",
        "[Participants:",
        "  alice (Alice) [human]",
        "  wren [mind] — writes about lighthouses and winter storms",
        "]",
        "hello",
      ].join("\n");
      assert.equal(cleanPrompt(prompt), "hello");
    });

    it("doesn't let one unmatched bracket swallow the rest of the prompt", () => {
      const prompt = ["[Participants:", "  alice [human", "", "the heron by the river"].join("\n");
      assert.equal(cleanPrompt(prompt), "the heron by the river");
      const next = ["[#garden — unclosed", "[Volute: alice in DM — 10:01]", "the heron"].join("\n");
      assert.equal(cleanPrompt(next), "the heron");
    });

    it("drops the router's batch header, batched prefixes and session instructions", () => {
      const prompt = [
        "[Session instructions: keep replies short.",
        "Mention the garden messages when relevant.]",
        "",
        "[Batch: 3 messages from #garden]",
        "",
        "[alice — 10:01]",
        "ok",
        "",
        "[bob — 10:02]",
        "sure",
      ].join("\n");
      assert.equal(queryTerms(cleanPrompt(prompt)).length, 0);
    });

    it("leaves nothing of a pure event turn", () => {
      assert.equal(
        cleanPrompt("=== System event: heartbeat — 2026-09-23 10:00 ===\nriver heron garden"),
        "",
      );
    });

    it("drops stopwords, short tokens and repeats", () => {
      assert.deepEqual(queryTerms("Do you remember the heron by the river? The HERON!"), [
        "remember",
        "heron",
        "river",
      ]);
      assert.deepEqual(queryTerms("hey, how are you today? ok :) lol"), []);
    });

    it("asks more of long messages", () => {
      assert.equal(minMatchedTerms(3), 2);
      assert.equal(minMatchedTerms(32), 4);
    });
  });

  describe("surface", () => {
    const mind = useMind();
    const config = testConfig();

    function seed() {
      write(
        mind.home,
        "memory/journal/2026-09-01.md",
        "# 2026-09-01\n\n## The river walk\n\nWalked the river path with Alice this morning. We talked about leaving the old garden behind and whether the heron would come back to the shallows next spring.\n\n## Evening\n\nRead a long essay about lighthouses and the keepers who tended them through winter storms, and thought about solitude as a kind of practice.",
      );
      write(
        mind.home,
        "MEMORY.md",
        "# Memory\n\nAlice is my friend. We talk about the river and the heron and gardens and many other things all the time.",
      );
      const db = openDb(mind.dir);
      syncFiles(db, config);
      return db;
    }

    it("brings back a memory the message genuinely echoes, attributed", () => {
      const db = seed();
      try {
        const items = surface(
          db,
          "[Volute: alice in DM — 2026-09-23 10:00]\nremember the heron by the river?",
          "s",
          config,
        );
        assert.equal(items.length, 1, "MEMORY.md is already in context and must not surface");
        assert.equal(items[0].sourceFile, "memory/journal/2026-09-01.md");
        assert.equal(items[0].section, "## The river walk");
        assert.ok(items[0].snippet.length <= 160);
        const text = formatSurfaced(items);
        assert.match(text, /\[id:\d+\] memory\/journal\/2026-09-01\.md § The river walk/);
        assert.doesNotMatch(text, /## The river walk/);
      } finally {
        db.close();
      }
    });

    it("stems, so a singular finds a plural", () => {
      const db = seed();
      try {
        assert.equal(surface(db, "lighthouse keeper", "s", config).length, 1);
      } finally {
        db.close();
      }
    });

    it("stays quiet on a single incidental word", () => {
      const db = seed();
      try {
        assert.deepEqual(surface(db, "what a practice session that was", "s", config), []);
      } finally {
        db.close();
      }
    });

    it("stays quiet on event and heartbeat turns", () => {
      const db = seed();
      try {
        const prompt = "=== System event: heartbeat — 2026-09-23 10:00 ===\nthe heron by the river";
        assert.deepEqual(surface(db, prompt, "s", config), []);
      } finally {
        db.close();
      }
    });

    it("doesn't resurface a memory in the same session, and counts each surfacing", () => {
      const db = seed();
      try {
        db.prepare("UPDATE memories SET strength = 0.5").run();
        const [first] = surface(db, "the heron by the river", "s1", config);
        assert.ok(first);
        assert.deepEqual(surface(db, "the heron by the river", "s1", config), []);
        assert.equal(surface(db, "the heron by the river", "s2", config).length, 1);
        const row = db
          .prepare("SELECT surfaced_count, strength FROM memories WHERE id = ?")
          .get(first.id) as { surfaced_count: number; strength: number };
        assert.equal(row.surfaced_count, 2);
        assert.ok(Math.abs(row.strength - 0.54) < 1e-9, `got ${row.strength}`);
      } finally {
        db.close();
      }
    });

    it("survives hostile and noisy input without errors or matches", () => {
      const db = seed();
      try {
        const probes = [
          '"',
          '""""',
          "*",
          "zzz*",
          "NEAR(zzz qqq)",
          "zzz AND NOT qqq",
          "zzz OR",
          "content:zzz",
          "^zzz",
          "{zzz qqq}",
          "(((",
          "'); DROP TABLE memories; --",
          "🌊🌊🌊",
          "\u0000\u0001",
          "a".repeat(10000),
          "...!!!???",
        ];
        for (const p of probes) {
          assert.deepEqual(surface(db, p, "probe", config), [], p);
          // Explicit search keeps every word ("and" is a fine thing to look for); it just
          // must never throw or pass syntax through to FTS5.
          assert.ok(Array.isArray(searchFts(db, p)), p);
        }
        assert.equal(count(db, "SELECT COUNT(*) AS c FROM memories"), 3);
      } finally {
        db.close();
      }
    });
  });

  describe("runHook", () => {
    const mind = useMind();

    it("creates its DB on first use — no install step, no config needed", () => {
      write(mind.home, "memory/journal/a.md", WALK);
      const out = runHook({ prompt: "the heron at the river", session: "main" });
      assert.ok(existsSync(join(mind.dir, ".mind", "resonance.db")));
      assert.ok(!existsSync(join(mind.home, ".config", "resonance.json")));
      assert.match(out.additionalContext ?? "", /memory\/journal\/a\.md § Walk/);
    });

    it("tells the mind, once per session, when its config is broken", () => {
      write(mind.home, ".config/resonance.json", "{ ingestion: ");
      assert.match(
        runHook({ prompt: "x", session: "a" }).additionalContext ?? "",
        /can't read.*paused/,
      );
      assert.deepEqual(runHook({ prompt: "x", session: "a" }), {}, "not again in the same session");
      assert.match(runHook({ prompt: "x", session: "b" }).additionalContext ?? "", /paused/);

      rmSync(join(mind.home, ".config", "resonance.json"));
      write(mind.home, ".config/config.json", JSON.stringify({ memory: { recall: "sometimes" } }));
      assert.match(
        runHook({ prompt: "x", session: "a" }).additionalContext ?? "",
        /"memory.recall" must be/,
        "a different problem is news",
      );
    });

    it("mentions a dropped ignore pattern once, and still recalls", () => {
      write(mind.home, "memory/journal/a.md", WALK);
      write(
        mind.home,
        ".config/resonance.json",
        JSON.stringify({ ingestion: { ignorePatterns: ["(bad"] } }),
      );
      const first = runHook({ prompt: "the heron at the river", session: "a" }).additionalContext;
      assert.match(first ?? "", /invalid ignorePatterns entry: \(bad/);
      assert.match(first ?? "", /§ Walk/);
      assert.deepEqual(runHook({ prompt: "the heron at the river", session: "a" }), {});
    });

    it("never throws, and logs what went wrong once", () => {
      write(mind.home, "memory/journal/a.md", WALK);
      mkdirSync(join(mind.dir, ".mind", "resonance.db"), { recursive: true }); // unopenable
      assert.deepEqual(runHook({ prompt: "the heron at the river", session: "a" }), {});
      assert.deepEqual(runHook({ prompt: "the heron at the river", session: "a" }), {});
      const log = readFileSync(join(mind.dir, ".mind", "resonance-hook-errors.log"), "utf-8");
      assert.equal(log.trim().split("\n").length, 1);
    });

    it("dedupes on the volute session, not the SDK's session id", () => {
      write(mind.home, "memory/journal/a.md", WALK);
      const input = { prompt: "the heron at the river", session: "main" };
      assert.ok(runHook({ ...input, session_id: "sdk-1" }).additionalContext);
      assert.deepEqual(runHook({ ...input, session_id: "sdk-2" }), {});
    });

    it("returns nothing without a prompt (older codex/pi hook input)", () => {
      assert.deepEqual(runHook({ event: "pre-prompt", session: "main" }), {});
    });

    it("honours recall: on-demand and off", () => {
      write(mind.home, "memory/journal/a.md", WALK);
      write(mind.home, ".config/config.json", JSON.stringify({ memory: { recall: "on-demand" } }));
      assert.deepEqual(runHook({ prompt: "the heron at the river", session: "main" }), {});
      assert.ok(existsSync(join(mind.dir, ".mind", "resonance.db")), "on-demand keeps the index");

      rmSync(join(mind.dir, ".mind"), { recursive: true });
      write(mind.home, ".config/config.json", JSON.stringify({ memory: { recall: "off" } }));
      assert.deepEqual(runHook({ prompt: "the heron at the river", session: "main" }), {});
      assert.ok(!existsSync(join(mind.dir, ".mind", "resonance.db")), "off does nothing at all");
    });
  });

  describe("search-hook script", () => {
    const mind = useMind();

    it("with recall off, stops before starting tsx at all", () => {
      cpSync(SKILL_DIR, join(mind.home, ".claude/skills/resonance"), { recursive: true });
      // No node_modules: if the script got as far as tsx, it would fail.
      write(mind.home, ".config/config.json", JSON.stringify({ memory: { recall: "off" } }));
      const r = spawnSync("bash", [".claude/skills/resonance/scripts/resonance-hook.sh"], {
        cwd: mind.home,
        input: JSON.stringify({ prompt: "the heron at the river", session: "main" }),
        env: { ...process.env, VOLUTE_MIND_DIR: mind.dir },
        encoding: "utf-8",
        timeout: 60_000,
      });
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(JSON.parse(r.stdout), {});
      assert.ok(!existsSync(join(mind.dir, ".mind")));
    });

    // The shim runs `bash <skills-subdir>/resonance/scripts/resonance-hook.sh` from home/.
    for (const subdir of [".claude/skills", ".agents/skills", ".pi/skills"]) {
      it(`runs from ${subdir} with no database yet`, () => {
        cpSync(SKILL_DIR, join(mind.home, subdir, "resonance"), { recursive: true });
        symlinkSync(join(REPO, "node_modules"), join(mind.dir, "node_modules"));
        write(mind.home, "memory/journal/a.md", WALK);
        const run = (input: string) =>
          spawnSync("bash", [`${subdir}/resonance/scripts/resonance-hook.sh`], {
            cwd: mind.home,
            input,
            env: { ...process.env, VOLUTE_MIND_DIR: mind.dir },
            encoding: "utf-8",
            timeout: 60_000,
          });

        const noPrompt = run(JSON.stringify({ event: "pre-prompt", session: "main" }));
        assert.equal(noPrompt.status, 0, noPrompt.stderr);
        assert.deepEqual(JSON.parse(noPrompt.stdout), {});

        const withPrompt = run(
          JSON.stringify({ prompt: "the heron at the river", session: "main" }),
        );
        assert.equal(withPrompt.status, 0, withPrompt.stderr);
        assert.match(JSON.parse(withPrompt.stdout).additionalContext, /§ Walk/);
      });
    }
  });
});
