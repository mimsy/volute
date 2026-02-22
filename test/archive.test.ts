import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import AdmZip from "adm-zip";
import {
  addHistoryToArchive,
  createExportArchive,
  extractArchive,
  readManifest,
} from "../src/lib/archive.js";
import { addMind, mindDir, removeMind, stateDir } from "../src/lib/registry.js";

const testMind = `archive-test-${Date.now()}`;

function setupMindDir() {
  const dir = mindDir(testMind);
  // Create minimal mind directory structure
  mkdirSync(resolve(dir, "home/.config"), { recursive: true });
  mkdirSync(resolve(dir, "src/lib"), { recursive: true });
  mkdirSync(resolve(dir, ".mind/identity"), { recursive: true });
  mkdirSync(resolve(dir, ".mind/connectors/discord"), { recursive: true });
  mkdirSync(resolve(dir, ".mind/sessions"), { recursive: true });
  mkdirSync(resolve(dir, "node_modules/.package-lock"), { recursive: true });
  mkdirSync(resolve(dir, ".variants/test"), { recursive: true });

  writeFileSync(resolve(dir, "home/SOUL.md"), "# Test Soul\n");
  writeFileSync(resolve(dir, "home/MEMORY.md"), "# Memory\n");
  writeFileSync(resolve(dir, "home/.config/volute.json"), '{"model":"test"}\n');
  writeFileSync(resolve(dir, "src/server.ts"), "console.log('server');\n");
  writeFileSync(resolve(dir, "src/lib/router.ts"), "export {};\n");
  writeFileSync(resolve(dir, ".mind/identity/private.pem"), "PRIVATE_KEY\n");
  writeFileSync(resolve(dir, ".mind/identity/public.pem"), "PUBLIC_KEY\n");
  writeFileSync(resolve(dir, ".mind/connectors/discord/config.json"), '{"token":"secret"}\n');
  writeFileSync(resolve(dir, ".mind/sessions/main.json"), '{"id":"sess-1"}\n');
  writeFileSync(resolve(dir, "node_modules/.package-lock/lock.json"), "lock\n");
  writeFileSync(resolve(dir, ".variants/test/dummy.txt"), "variant\n");

  // Create state dir files
  const state = stateDir(testMind);
  mkdirSync(state, { recursive: true });
  writeFileSync(resolve(state, "channels.json"), '{"discord:general":"123"}\n');
  writeFileSync(resolve(state, "env.json"), '{"API_KEY":"secret"}\n');

  return dir;
}

describe("archive", () => {
  beforeEach(() => {
    addMind(testMind, 4199, undefined, "claude");
    setupMindDir();
  });

  afterEach(() => {
    removeMind(testMind);
    const dir = mindDir(testMind);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    const state = stateDir(testMind);
    if (existsSync(state)) rmSync(state, { recursive: true, force: true });
  });

  describe("createExportArchive", () => {
    it("creates a zip with manifest", () => {
      const zip = createExportArchive({ name: testMind, template: "claude" });
      const manifest = zip.getEntry("manifest.json");
      assert.ok(manifest);

      const parsed = JSON.parse(manifest.getData().toString("utf-8"));
      assert.equal(parsed.version, 1);
      assert.equal(parsed.name, testMind);
      assert.equal(parsed.template, "claude");
      assert.ok(parsed.exportedAt);
    });

    it("includes mind files under mind/ prefix", () => {
      const zip = createExportArchive({ name: testMind, template: "claude" });
      const entries = zip.getEntries().map((e) => e.entryName);

      assert.ok(entries.includes("mind/home/SOUL.md"));
      assert.ok(entries.includes("mind/src/server.ts"));
      assert.ok(entries.includes("mind/src/lib/router.ts"));
    });

    it("excludes node_modules and .variants", () => {
      const zip = createExportArchive({ name: testMind, template: "claude" });
      const entries = zip.getEntries().map((e) => e.entryName);

      assert.ok(!entries.some((e) => e.includes("node_modules")));
      assert.ok(!entries.some((e) => e.includes(".variants")));
    });

    it("excludes identity by default", () => {
      const zip = createExportArchive({ name: testMind, template: "claude" });
      const entries = zip.getEntries().map((e) => e.entryName);

      assert.ok(!entries.some((e) => e.includes("identity/private.pem")));
      assert.ok(!entries.some((e) => e.includes("identity/public.pem")));
    });

    it("includes identity when requested", () => {
      const zip = createExportArchive({
        name: testMind,
        template: "claude",
        includeIdentity: true,
      });
      const entries = zip.getEntries().map((e) => e.entryName);

      assert.ok(entries.includes("mind/.mind/identity/private.pem"));
      assert.ok(entries.includes("mind/.mind/identity/public.pem"));
    });

    it("excludes connectors by default", () => {
      const zip = createExportArchive({ name: testMind, template: "claude" });
      const entries = zip.getEntries().map((e) => e.entryName);

      assert.ok(!entries.some((e) => e.includes("connectors/discord")));
    });

    it("includes connectors when requested", () => {
      const zip = createExportArchive({
        name: testMind,
        template: "claude",
        includeConnectors: true,
      });
      const entries = zip.getEntries().map((e) => e.entryName);

      assert.ok(entries.includes("mind/.mind/connectors/discord/config.json"));
    });

    it("always includes channels.json from state dir", () => {
      const zip = createExportArchive({ name: testMind, template: "claude" });
      const entry = zip.getEntry("state/channels.json");
      assert.ok(entry);
      assert.ok(entry.getData().toString("utf-8").includes("discord:general"));
    });

    it("excludes env.json by default", () => {
      const zip = createExportArchive({ name: testMind, template: "claude" });
      const entry = zip.getEntry("state/env.json");
      assert.ok(!entry);
    });

    it("includes env.json when requested", () => {
      const zip = createExportArchive({
        name: testMind,
        template: "claude",
        includeEnv: true,
      });
      const entry = zip.getEntry("state/env.json");
      assert.ok(entry);
      assert.ok(entry.getData().toString("utf-8").includes("API_KEY"));
    });

    it("includes sessions when requested", () => {
      const zip = createExportArchive({
        name: testMind,
        template: "claude",
        includeSessions: true,
      });
      const entries = zip.getEntries().map((e) => e.entryName);

      assert.ok(entries.includes("sessions/main.json"));
    });

    it("excludes .git directory", () => {
      // Add a fake .git dir
      const dir = mindDir(testMind);
      mkdirSync(resolve(dir, ".git/objects"), { recursive: true });
      writeFileSync(resolve(dir, ".git/HEAD"), "ref: refs/heads/main\n");

      const zip = createExportArchive({ name: testMind, template: "claude" });
      const entries = zip.getEntries().map((e) => e.entryName);

      assert.ok(!entries.some((e) => e.includes(".git")));
    });

    it("handles missing state directory gracefully", () => {
      const state = stateDir(testMind);
      rmSync(state, { recursive: true, force: true });

      const zip = createExportArchive({ name: testMind, template: "claude" });
      assert.ok(zip.getEntry("manifest.json"));
      assert.ok(!zip.getEntry("state/channels.json"));
      assert.ok(!zip.getEntry("state/env.json"));
    });

    it("does not duplicate sessions in mind/ when includeSessions is true", () => {
      const zip = createExportArchive({
        name: testMind,
        template: "claude",
        includeSessions: true,
      });
      const entries = zip.getEntries().map((e) => e.entryName);

      // Sessions should be at sessions/ prefix only, not in mind/.mind/sessions/
      assert.ok(entries.includes("sessions/main.json"));
      assert.ok(!entries.some((e) => e.startsWith("mind/.mind/sessions/")));
    });

    it("sets manifest includes flags correctly", () => {
      const zip = createExportArchive({
        name: testMind,
        template: "claude",
        includeEnv: true,
        includeIdentity: true,
        includeConnectors: true,
        includeHistory: true,
        includeSessions: true,
      });
      const manifest = JSON.parse(zip.getEntry("manifest.json")!.getData().toString("utf-8"));

      assert.equal(manifest.includes.env, true);
      assert.equal(manifest.includes.identity, true);
      assert.equal(manifest.includes.connectors, true);
      assert.equal(manifest.includes.history, true);
      assert.equal(manifest.includes.sessions, true);
    });
  });

  describe("addHistoryToArchive", () => {
    it("adds history.jsonl to zip", () => {
      const zip = createExportArchive({ name: testMind, template: "claude" });
      const rows = [
        { mind: testMind, type: "inbound", content: "hello" },
        { mind: testMind, type: "outbound", content: "hi" },
      ];
      addHistoryToArchive(zip, rows);

      const entry = zip.getEntry("history.jsonl");
      assert.ok(entry);
      const lines = entry.getData().toString("utf-8").trim().split("\n");
      assert.equal(lines.length, 2);
      assert.equal(JSON.parse(lines[0]).content, "hello");
    });

    it("does nothing with empty rows", () => {
      const zip = createExportArchive({ name: testMind, template: "claude" });
      addHistoryToArchive(zip, []);

      assert.ok(!zip.getEntry("history.jsonl"));
    });
  });

  describe("readManifest", () => {
    it("reads manifest from a .volute file", () => {
      const zip = createExportArchive({ name: testMind, template: "claude" });
      const archivePath = resolve("/tmp", `${testMind}.volute`);
      writeFileSync(archivePath, zip.toBuffer());

      try {
        const manifest = readManifest(archivePath);
        assert.equal(manifest.version, 1);
        assert.equal(manifest.name, testMind);
      } finally {
        rmSync(archivePath, { force: true });
      }
    });

    it("throws on missing manifest", () => {
      const zip = new AdmZip();
      zip.addFile("dummy.txt", Buffer.from("test"));
      const archivePath = resolve("/tmp", `${testMind}-bad.volute`);
      writeFileSync(archivePath, zip.toBuffer());

      try {
        assert.throws(() => readManifest(archivePath), /missing manifest/);
      } finally {
        rmSync(archivePath, { force: true });
      }
    });
  });

  describe("readManifest", () => {
    it("throws on unsupported manifest version", () => {
      const zip = new AdmZip();
      zip.addFile("manifest.json", Buffer.from(JSON.stringify({ version: 2, name: "test" })));
      const archivePath = resolve("/tmp", `${testMind}-v2.volute`);
      writeFileSync(archivePath, zip.toBuffer());
      try {
        assert.throws(() => readManifest(archivePath), /Unsupported archive version/);
      } finally {
        rmSync(archivePath, { force: true });
      }
    });
  });

  describe("extractArchive", () => {
    it("rejects archives with path traversal entries", () => {
      const zip = new AdmZip();
      zip.addFile(
        "manifest.json",
        Buffer.from(
          JSON.stringify({
            version: 1,
            name: "evil",
            template: "claude",
            voluteVersion: "1.0.0",
            exportedAt: new Date().toISOString(),
            includes: {
              env: false,
              identity: false,
              connectors: false,
              history: false,
              sessions: false,
            },
          }),
        ),
      );
      zip.addFile("mind/home/SOUL.md", Buffer.from("legit"));
      // adm-zip normalizes ../  in addFile, so mutate entry name after creation
      zip.addFile("etc/evil.txt", Buffer.from("pwned"));
      const entries = zip.getEntries();
      entries[entries.length - 1].entryName = "../../etc/evil.txt";

      const archivePath = resolve("/tmp", `${testMind}-evil.volute`);
      const destDir = resolve("/tmp", `${testMind}-evil-dest`);
      writeFileSync(archivePath, zip.toBuffer());

      try {
        assert.throws(() => extractArchive(archivePath, destDir), /path traversal/);
      } finally {
        rmSync(archivePath, { force: true });
        rmSync(destDir, { recursive: true, force: true });
      }
    });

    it("extracts mind directory and state files", () => {
      const zip = createExportArchive({
        name: testMind,
        template: "claude",
        includeEnv: true,
      });
      const archivePath = resolve("/tmp", `${testMind}-extract.volute`);
      const destDir = resolve("/tmp", `${testMind}-dest`);
      writeFileSync(archivePath, zip.toBuffer());

      try {
        const result = extractArchive(archivePath, destDir);

        assert.equal(result.manifest.name, testMind);
        assert.ok(existsSync(resolve(result.mindDir, "home/SOUL.md")));
        assert.ok(existsSync(resolve(result.mindDir, "src/server.ts")));
        assert.ok(result.channelsJson);
        assert.ok(result.envJson);
      } finally {
        rmSync(archivePath, { force: true });
        rmSync(destDir, { recursive: true, force: true });
      }
    });

    it("returns null for optional files not present", () => {
      const zip = createExportArchive({ name: testMind, template: "claude" });
      const archivePath = resolve("/tmp", `${testMind}-minimal.volute`);
      const destDir = resolve("/tmp", `${testMind}-minimal-dest`);
      writeFileSync(archivePath, zip.toBuffer());

      try {
        const result = extractArchive(archivePath, destDir);

        assert.equal(result.envJson, null);
        assert.equal(result.historyJsonl, null);
        assert.equal(result.sessionsDir, null);
      } finally {
        rmSync(archivePath, { force: true });
        rmSync(destDir, { recursive: true, force: true });
      }
    });

    it("extracts history and sessions when present", () => {
      const zip = createExportArchive({
        name: testMind,
        template: "claude",
        includeSessions: true,
        includeHistory: true,
      });
      addHistoryToArchive(zip, [{ mind: testMind, type: "inbound", content: "test" }]);

      const archivePath = resolve("/tmp", `${testMind}-full.volute`);
      const destDir = resolve("/tmp", `${testMind}-full-dest`);
      writeFileSync(archivePath, zip.toBuffer());

      try {
        const result = extractArchive(archivePath, destDir);

        assert.ok(result.historyJsonl);
        assert.ok(result.sessionsDir);
        assert.ok(existsSync(resolve(result.sessionsDir!, "main.json")));
      } finally {
        rmSync(archivePath, { force: true });
        rmSync(destDir, { recursive: true, force: true });
      }
    });
  });

  describe("round-trip", () => {
    it("export then extract preserves mind content", () => {
      const zip = createExportArchive({
        name: testMind,
        template: "claude",
        includeIdentity: true,
        includeConnectors: true,
        includeEnv: true,
      });

      const archivePath = resolve("/tmp", `${testMind}-roundtrip.volute`);
      const destDir = resolve("/tmp", `${testMind}-roundtrip-dest`);
      writeFileSync(archivePath, zip.toBuffer());

      try {
        const result = extractArchive(archivePath, destDir);

        // Check mind files are preserved
        const soul = readFileSync(resolve(result.mindDir, "home/SOUL.md"), "utf-8");
        assert.equal(soul, "# Test Soul\n");

        const memory = readFileSync(resolve(result.mindDir, "home/MEMORY.md"), "utf-8");
        assert.equal(memory, "# Memory\n");

        // Check identity preserved
        const privateKey = readFileSync(
          resolve(result.mindDir, ".mind/identity/private.pem"),
          "utf-8",
        );
        assert.equal(privateKey, "PRIVATE_KEY\n");

        // Check connectors preserved
        const discordConfig = readFileSync(
          resolve(result.mindDir, ".mind/connectors/discord/config.json"),
          "utf-8",
        );
        assert.ok(discordConfig.includes("secret"));

        // Check state preserved
        const channels = readFileSync(result.channelsJson!, "utf-8");
        assert.ok(channels.includes("discord:general"));

        const env = readFileSync(result.envJson!, "utf-8");
        assert.ok(env.includes("API_KEY"));
      } finally {
        rmSync(archivePath, { force: true });
        rmSync(destDir, { recursive: true, force: true });
      }
    });
  });
});
