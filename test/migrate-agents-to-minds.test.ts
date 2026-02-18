import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { migrateAgentsToMinds } from "../src/lib/migrate-agents-to-minds.js";
import { voluteHome } from "../src/lib/registry.js";

describe("migrateAgentsToMinds", () => {
  let home: string;

  beforeEach(() => {
    home = voluteHome();
    mkdirSync(home, { recursive: true });
    // Clean env vars that affect migration behavior
    delete process.env.VOLUTE_AGENTS_DIR;
    delete process.env.VOLUTE_MINDS_DIR;
  });

  afterEach(() => {
    // Clean up files created during tests
    for (const f of ["agents.json", "agents.json.bak", "minds.json"]) {
      const p = resolve(home, f);
      if (existsSync(p)) rmSync(p);
    }
    for (const d of ["agents", "minds", "state"]) {
      const p = resolve(home, d);
      if (existsSync(p)) rmSync(p, { recursive: true, force: true });
    }
    delete process.env.VOLUTE_AGENTS_DIR;
    delete process.env.VOLUTE_MINDS_DIR;
  });

  describe("registry migration", () => {
    it("renames agents.json to minds.json", () => {
      const entries = [{ name: "alice", port: 4100, created: "2025-01-01T00:00:00.000Z" }];
      writeFileSync(resolve(home, "agents.json"), JSON.stringify(entries));

      migrateAgentsToMinds();

      assert.ok(existsSync(resolve(home, "minds.json")));
      assert.ok(!existsSync(resolve(home, "agents.json")), "original should be renamed to .bak");
      assert.ok(existsSync(resolve(home, "agents.json.bak")));
    });

    it("updates stage 'mind' to 'sprouted'", () => {
      const entries = [
        { name: "alice", port: 4100, stage: "mind" },
        { name: "bob", port: 4101, stage: "seed" },
      ];
      writeFileSync(resolve(home, "agents.json"), JSON.stringify(entries));

      migrateAgentsToMinds();

      const result = JSON.parse(readFileSync(resolve(home, "minds.json"), "utf-8"));
      assert.equal(result[0].stage, "sprouted");
      assert.equal(result[1].stage, "seed");
    });

    it("skips if minds.json already exists", () => {
      writeFileSync(resolve(home, "agents.json"), JSON.stringify([{ name: "old" }]));
      writeFileSync(resolve(home, "minds.json"), JSON.stringify([{ name: "new" }]));

      migrateAgentsToMinds();

      const result = JSON.parse(readFileSync(resolve(home, "minds.json"), "utf-8"));
      assert.equal(result[0].name, "new", "should not overwrite existing minds.json");
    });

    it("no-ops when no agents.json exists", () => {
      migrateAgentsToMinds();
      assert.ok(!existsSync(resolve(home, "minds.json")));
    });
  });

  describe("directory migration", () => {
    it("renames agents/ to minds/", () => {
      mkdirSync(resolve(home, "agents", "alice"), { recursive: true });
      writeFileSync(resolve(home, "agents.json"), JSON.stringify([{ name: "alice" }]));

      migrateAgentsToMinds();

      assert.ok(existsSync(resolve(home, "minds", "alice")));
      assert.ok(!existsSync(resolve(home, "agents")));
    });

    it("skips directory rename if minds/ already exists", () => {
      mkdirSync(resolve(home, "agents", "old"), { recursive: true });
      mkdirSync(resolve(home, "minds", "new"), { recursive: true });
      writeFileSync(resolve(home, "agents.json"), JSON.stringify([{ name: "old" }]));

      migrateAgentsToMinds();

      assert.ok(existsSync(resolve(home, "agents", "old")), "should not delete agents/");
      assert.ok(existsSync(resolve(home, "minds", "new")), "should preserve minds/");
    });

    it("skips directory rename when VOLUTE_MINDS_DIR is set", () => {
      process.env.VOLUTE_MINDS_DIR = resolve(home, "custom-minds");
      mkdirSync(resolve(home, "agents", "alice"), { recursive: true });
      writeFileSync(resolve(home, "agents.json"), JSON.stringify([{ name: "alice" }]));

      migrateAgentsToMinds();

      assert.ok(existsSync(resolve(home, "agents", "alice")), "should not touch agents/");
    });
  });

  describe("env var bridging", () => {
    it("bridges VOLUTE_AGENTS_DIR to VOLUTE_MINDS_DIR", () => {
      process.env.VOLUTE_AGENTS_DIR = "/custom/agents";
      writeFileSync(resolve(home, "agents.json"), JSON.stringify([{ name: "alice" }]));

      migrateAgentsToMinds();

      assert.equal(process.env.VOLUTE_MINDS_DIR, "/custom/agents");
    });

    it("does not override existing VOLUTE_MINDS_DIR", () => {
      process.env.VOLUTE_AGENTS_DIR = "/old/agents";
      process.env.VOLUTE_MINDS_DIR = "/new/minds";
      writeFileSync(resolve(home, "agents.json"), JSON.stringify([{ name: "alice" }]));

      migrateAgentsToMinds();

      assert.equal(process.env.VOLUTE_MINDS_DIR, "/new/minds");
    });
  });

  describe("log file migration", () => {
    it("renames agent.log to mind.log", () => {
      const entries = [{ name: "alice", port: 4100 }];
      writeFileSync(resolve(home, "agents.json"), JSON.stringify(entries));

      const logsDir = resolve(home, "state", "alice", "logs");
      mkdirSync(logsDir, { recursive: true });
      writeFileSync(resolve(logsDir, "agent.log"), "old log content");

      migrateAgentsToMinds();

      assert.ok(existsSync(resolve(logsDir, "mind.log")));
      assert.ok(!existsSync(resolve(logsDir, "agent.log")));
      assert.equal(readFileSync(resolve(logsDir, "mind.log"), "utf-8"), "old log content");
    });

    it("skips log rename if mind.log already exists", () => {
      const entries = [{ name: "alice", port: 4100 }];
      writeFileSync(resolve(home, "agents.json"), JSON.stringify(entries));

      const logsDir = resolve(home, "state", "alice", "logs");
      mkdirSync(logsDir, { recursive: true });
      writeFileSync(resolve(logsDir, "agent.log"), "old");
      writeFileSync(resolve(logsDir, "mind.log"), "new");

      migrateAgentsToMinds();

      assert.equal(readFileSync(resolve(logsDir, "mind.log"), "utf-8"), "new");
    });

    it("skips log rename when no logs directory exists", () => {
      const entries = [{ name: "alice", port: 4100 }];
      writeFileSync(resolve(home, "agents.json"), JSON.stringify(entries));

      migrateAgentsToMinds();

      // Should not throw, just skip
      assert.ok(!existsSync(resolve(home, "state", "alice", "logs", "mind.log")));
    });
  });

  describe("idempotency", () => {
    it("safe to run multiple times", () => {
      const entries = [{ name: "alice", port: 4100, stage: "mind" }];
      writeFileSync(resolve(home, "agents.json"), JSON.stringify(entries));
      mkdirSync(resolve(home, "agents", "alice"), { recursive: true });
      const logsDir = resolve(home, "state", "alice", "logs");
      mkdirSync(logsDir, { recursive: true });
      writeFileSync(resolve(logsDir, "agent.log"), "log content");

      migrateAgentsToMinds();
      migrateAgentsToMinds();

      const result = JSON.parse(readFileSync(resolve(home, "minds.json"), "utf-8"));
      assert.equal(result[0].stage, "sprouted");
      assert.ok(existsSync(resolve(home, "minds", "alice")));
      assert.equal(readFileSync(resolve(logsDir, "mind.log"), "utf-8"), "log content");
    });
  });
});
