import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { mindSkillsDir } from "../packages/daemon/src/lib/skills.js";
import {
  applyInitFiles,
  composeTemplate,
  copyTemplateToDir,
  findTemplatesRoot,
} from "../packages/daemon/src/lib/template/template.js";
import {
  countSdkInstructionTokens,
  readSdkInstructions,
} from "../templates/_base/src/lib/context-breakdown.js";
import { MECHANICS_DOC, withMechanicsDoc } from "../templates/pi/src/lib/mechanics-doc.js";

/**
 * Build a mind directory from a real template exactly as `mind create` does
 * (compose _base + template, copy with {{name}} substitution, apply .init/).
 * Returns the mind dir; every assertion below therefore runs against the files
 * a freshly-created mind actually has on disk.
 */
const scratch: string[] = [];
function createMindDir(template: string): string {
  const dest = mkdtempSync(resolve(tmpdir(), `volute-mind-${template}-`));
  scratch.push(dest);
  const { composedDir, manifest } = composeTemplate(findTemplatesRoot(), template);
  try {
    copyTemplateToDir(composedDir, dest, "testmind", manifest);
  } finally {
    rmSync(composedDir, { recursive: true, force: true });
  }
  applyInitFiles(dest);
  return dest;
}

after(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

describe("pi mechanics doc reaches the system prompt", () => {
  it("appends the mind's MINDS.md to the system prompt", () => {
    const home = resolve(createMindDir("pi"), "home");
    const doc = readFileSync(resolve(home, MECHANICS_DOC), "utf-8");
    assert.ok(doc.trim().length > 0, "pi template must ship a non-empty mechanics doc");

    const prompt = withMechanicsDoc("SOUL", home);
    assert.notEqual(prompt, "SOUL", "mechanics doc was not appended");
    assert.ok(prompt.startsWith("SOUL"), "base system prompt must be preserved");
    assert.ok(prompt.includes(doc.trim()), "full mechanics doc must be in the system prompt");
  });

  it("wires the mechanics doc into the prompt pi is actually started with", () => {
    // The helper above is only useful if server.ts applies it. A source-level
    // check is crude, but the wiring is exactly what was missing (#801) and
    // importing server.ts would boot a real HTTP server.
    const dir = createMindDir("pi");
    assert.ok(existsSync(resolve(dir, "src/lib/mechanics-doc.ts")), "helper must ship in template");
    const server = readFileSync(resolve(dir, "src/server.ts"), "utf-8");
    assert.match(server, /withMechanicsDoc\(\s*loadSystemPrompt\(/);
  });

  it("is a no-op when the mind has no mechanics doc", () => {
    const home = mkdtempSync(resolve(tmpdir(), "volute-empty-home-"));
    scratch.push(home);
    assert.equal(withMechanicsDoc("SOUL", home), "SOUL");
  });

  it("pi ships no runtime-auto-loaded instruction file, so the doc is not double-counted", () => {
    // pi only auto-loads AGENTS.md/CLAUDE.md. If either ever appears in the pi
    // template, MINDS.md becomes dead weight and this accounting is wrong.
    const home = resolve(createMindDir("pi"), "home");
    assert.ok(!existsSync(resolve(home, "AGENTS.md")));
    assert.ok(!existsSync(resolve(home, "CLAUDE.md")));
    assert.equal(readSdkInstructions(home), "");
    assert.equal(countSdkInstructionTokens(home), 0);
  });

  it("claude and codex minds still report their runtime-loaded instruction file", () => {
    for (const [template, file] of [
      ["claude", "CLAUDE.md"],
      ["codex", "AGENTS.md"],
    ] as const) {
      const home = resolve(createMindDir(template), "home");
      assert.ok(existsSync(resolve(home, file)), `${template} must ship ${file}`);
      assert.ok(readSdkInstructions(home).length > 0, `${template} instructions must be read`);
      assert.ok(countSdkInstructionTokens(home) > 0, `${template} instructions must be counted`);
    }
  });
});

describe("template skills directory resolves from real template output", () => {
  // The discriminator in skills.ts probes mechanics-doc filenames. These cases
  // run it against freshly-created minds rather than synthetic marker files, so
  // renaming a template's mechanics doc fails here instead of silently pointing
  // a mind at a skills directory its runtime never reads.
  const expected: Record<string, string> = {
    claude: join("home", ".claude", "skills"),
    pi: join("home", ".pi", "skills"),
    codex: join("home", ".agents", "skills"),
  };

  for (const [template, suffix] of Object.entries(expected)) {
    it(`${template} mind resolves to ${suffix}`, () => {
      const dir = createMindDir(template);
      assert.equal(mindSkillsDir(dir), resolve(dir, suffix));
    });
  }

  it("gives each template a distinct skills directory", () => {
    const dirs = Object.keys(expected).map((t) => mindSkillsDir(createMindDir(t)).split("home")[1]);
    assert.equal(new Set(dirs).size, dirs.length, "templates must not collide on a skills dir");
  });
});
