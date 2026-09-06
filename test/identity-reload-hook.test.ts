import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { composeTemplate } from "../packages/daemon/src/lib/template/template.js";
import { createIdentityWatch } from "../templates/_base/src/lib/identity-watch.js";

const cwd = "/home/mind";

// The claude hook only reads tool_input.file_path; call it with just that shape.
type FileHook = (input: { tool_input?: { file_path?: string } }) => Promise<unknown>;

// The claude hook imports lib/identity-watch.ts, which only exists once _base and
// claude are layered together at mind-create time — so compose and import the real thing.
let composedDir: string;
let createIdentityReloadHook: (cwd: string) => {
  hook: FileHook;
  shouldRequestReload: () => boolean;
};

before(async () => {
  const templatesRoot = resolve(fileURLToPath(import.meta.url), "../../templates");
  composedDir = composeTemplate(templatesRoot, "claude").composedDir;
  ({ createIdentityReloadHook } = await import(
    resolve(composedDir, "src/lib/hooks/identity-reload.js")
  ));
});

after(() => {
  if (composedDir) rmSync(composedDir, { recursive: true, force: true });
});

async function fire(hook: FileHook, filePath?: string) {
  await hook({ tool_input: filePath ? { file_path: filePath } : {} });
}

describe("identity watch", () => {
  it("does not request a reload without an identity-file edit", () => {
    const watch = createIdentityWatch(cwd);
    watch.noteFileChange("notes/todo.md");
    assert.equal(watch.shouldRequestReload(), false);
  });

  it("requests a reload for each of the system prompt's source files", () => {
    for (const file of ["SOUL.md", "MEMORY.md", "VOLUTE.md"]) {
      const watch = createIdentityWatch(cwd);
      watch.noteFileChange(file);
      assert.equal(watch.shouldRequestReload(), true, `${file} should request a reload`);
    }
  });

  it("ignores identity-named files outside the mind's cwd", () => {
    const watch = createIdentityWatch(cwd);
    watch.noteFileChange("/etc/SOUL.md");
    assert.equal(watch.shouldRequestReload(), false);
  });

  it("latches: fires at most once so a failed restart doesn't loop", () => {
    const watch = createIdentityWatch(cwd);
    watch.noteFileChange("SOUL.md");
    assert.equal(watch.shouldRequestReload(), true, "first check should request the reload");
    assert.equal(watch.shouldRequestReload(), false, "subsequent checks must not re-fire");
    // A later identity edit must not re-arm the latch either.
    watch.noteFileChange("VOLUTE.md");
    assert.equal(watch.shouldRequestReload(), false, "latch stays closed after the first request");
  });
});

describe("claude template identity reload hook", () => {
  it("does not request a reload without an identity-file edit", async () => {
    const { hook, shouldRequestReload } = createIdentityReloadHook(cwd);
    await fire(hook);
    await fire(hook, "notes/todo.md");
    assert.equal(shouldRequestReload(), false);
  });

  it("requests a reload when an identity file changes", async () => {
    const { hook, shouldRequestReload } = createIdentityReloadHook(cwd);
    await fire(hook, "MEMORY.md");
    assert.equal(shouldRequestReload(), true);
  });

  it("ignores identity-named files outside the mind's cwd", async () => {
    const { hook, shouldRequestReload } = createIdentityReloadHook(cwd);
    await fire(hook, "/etc/SOUL.md");
    assert.equal(shouldRequestReload(), false);
  });

  it("latches: fires at most once so a failed restart doesn't loop", async () => {
    const { hook, shouldRequestReload } = createIdentityReloadHook(cwd);
    await fire(hook, "SOUL.md");
    assert.equal(shouldRequestReload(), true, "first check should request the reload");
    assert.equal(shouldRequestReload(), false, "subsequent checks must not re-fire");
    await fire(hook, "VOLUTE.md");
    assert.equal(shouldRequestReload(), false, "latch stays closed after the first request");
  });
});
