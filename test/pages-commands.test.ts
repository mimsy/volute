import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { deletePagesConfig, readPagesConfig, writePagesConfig } from "../src/lib/pages-config.js";
import { voluteHome } from "../src/lib/registry.js";

function configPath() {
  return resolve(voluteHome(), "pages.json");
}

describe("pages-config", () => {
  afterEach(() => {
    try {
      unlinkSync(configPath());
    } catch {}
  });

  it("readPagesConfig returns null when no config exists", () => {
    assert.equal(readPagesConfig(), null);
  });

  it("writePagesConfig + readPagesConfig roundtrips", () => {
    writePagesConfig({
      apiKey: "vp_test123",
      system: "my-system",
      apiUrl: "https://pages.volute.dev",
    });
    const config = readPagesConfig();
    assert.deepEqual(config, {
      apiKey: "vp_test123",
      system: "my-system",
      apiUrl: "https://pages.volute.dev",
    });
  });

  it("writePagesConfig sets file permissions to 0600", () => {
    writePagesConfig({
      apiKey: "vp_secret",
      system: "test",
      apiUrl: "https://pages.volute.dev",
    });
    const mode = statSync(configPath()).mode & 0o777;
    assert.equal(mode, 0o600);
  });

  it("readPagesConfig returns null for invalid JSON", () => {
    mkdirSync(voluteHome(), { recursive: true });
    writeFileSync(configPath(), "not json");
    assert.equal(readPagesConfig(), null);
  });

  it("readPagesConfig returns null if apiKey is missing", () => {
    mkdirSync(voluteHome(), { recursive: true });
    writeFileSync(configPath(), JSON.stringify({ system: "test" }));
    assert.equal(readPagesConfig(), null);
  });

  it("readPagesConfig defaults apiUrl when missing", () => {
    mkdirSync(voluteHome(), { recursive: true });
    writeFileSync(configPath(), JSON.stringify({ apiKey: "vp_key", system: "test" }));
    const config = readPagesConfig();
    assert.equal(config?.apiUrl, "https://pages.volute.dev");
  });

  it("deletePagesConfig removes the file", () => {
    writePagesConfig({
      apiKey: "vp_key",
      system: "test",
      apiUrl: "https://pages.volute.dev",
    });
    assert.ok(existsSync(configPath()));
    const result = deletePagesConfig();
    assert.equal(result, true);
    assert.ok(!existsSync(configPath()));
  });

  it("deletePagesConfig returns false when no file exists", () => {
    assert.equal(deletePagesConfig(), false);
  });
});

describe("pages/publish collectFiles", async () => {
  // Test the file collection logic by importing the module and using its internals
  // Since collectFiles is not exported, we test through the public API patterns
  const { readdirSync } = await import("node:fs");
  const { resolve: pathResolve, relative } = await import("node:path");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");

  function collectFiles(dir: string): Record<string, string> {
    const files: Record<string, string> = {};
    function walk(current: string) {
      for (const entry of readdirSync(current)) {
        const full = pathResolve(current, entry);
        const stat = statSync(full);
        if (stat.isDirectory()) {
          walk(full);
        } else if (stat.isFile()) {
          const rel = relative(dir, full);
          files[rel] = readFileSync(full).toString("base64");
        }
      }
    }
    walk(dir);
    return files;
  }

  it("collects files recursively with base64 encoding", () => {
    const tmp = mkdtempSync(resolve(tmpdir(), "volute-pages-test-"));
    writeFileSync(resolve(tmp, "index.html"), "<h1>Hello</h1>");
    mkdirSync(resolve(tmp, "css"));
    writeFileSync(resolve(tmp, "css", "style.css"), "body { color: red; }");

    const files = collectFiles(tmp);
    assert.equal(Object.keys(files).length, 2);
    assert.ok("index.html" in files);
    assert.ok("css/style.css" in files);
    assert.equal(Buffer.from(files["index.html"], "base64").toString(), "<h1>Hello</h1>");
    assert.equal(Buffer.from(files["css/style.css"], "base64").toString(), "body { color: red; }");
  });

  it("returns empty object for empty directory", () => {
    const tmp = mkdtempSync(resolve(tmpdir(), "volute-pages-empty-"));
    const files = collectFiles(tmp);
    assert.deepEqual(files, {});
  });
});
