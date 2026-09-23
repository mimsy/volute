import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * A mind's own process runs with umask 077, so everything it and its children
 * (the Agent SDK, codex, git, npm) create is private by construction (#1083).
 * Under user isolation the umask otherwise arrives from the daemon unchanged,
 * which left session transcripts at 755 on a real host (#959).
 */

const here = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = resolve(here, "..", "templates");
const STARTUP = resolve(TEMPLATES_DIR, "_base/src/lib/startup.ts");

describe("mind private umask", () => {
  it("setPrivateUmask makes new dirs 0700 and files 0600", () => {
    const dir = mkdtempSync(join(tmpdir(), "volute-umask-"));
    try {
      // process.umask is process-global: exercise it in a child so the test
      // runner's own file modes are left alone. Start from a permissive umask so
      // a no-op helper cannot pass by inheriting a strict one.
      const script = `
        import { mkdirSync, writeFileSync } from "node:fs";
        process.umask(0o022);
        const { setPrivateUmask } = await import(${JSON.stringify(pathToFileURL(STARTUP).href)});
        setPrivateUmask();
        mkdirSync(${JSON.stringify(join(dir, "projects"))});
        writeFileSync(${JSON.stringify(join(dir, "projects", "t.jsonl"))}, "x");
      `;
      execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
        stdio: "pipe",
      });
      assert.equal(statSync(join(dir, "projects")).mode & 0o777, 0o700);
      assert.equal(statSync(join(dir, "projects", "t.jsonl")).mode & 0o777, 0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const templates = readdirSync(TEMPLATES_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("_"))
    .map((e) => e.name)
    .filter((name) => {
      try {
        statSync(resolve(TEMPLATES_DIR, name, "src/server.ts"));
        return true;
      } catch {
        return false;
      }
    });

  it("finds the mind templates", () => {
    assert.ok(templates.includes("claude"), `templates found: ${templates.join(", ")}`);
  });

  for (const name of templates) {
    it(`${name}/src/server.ts sets the umask before creating the mind`, () => {
      const src = readFileSync(resolve(TEMPLATES_DIR, name, "src/server.ts"), "utf-8");
      const call = src.indexOf("\nsetPrivateUmask();");
      const create = src.indexOf("createMind(");
      assert.ok(call !== -1, "server.ts must call setPrivateUmask() at top level");
      assert.ok(create !== -1, "server.ts no longer calls createMind(");
      assert.ok(call < create, "setPrivateUmask() must run before createMind(");
    });
  }
});
