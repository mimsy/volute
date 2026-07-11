import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createIdentityReloadHook } from "../templates/claude/src/lib/hooks/identity-reload.js";

const cwd = "/home/mind";

// The hook only reads tool_input.file_path; call it with just that shape.
type FileHook = (input: { tool_input?: { file_path?: string } }) => Promise<unknown>;
async function fire(hook: FileHook, filePath?: string) {
  await hook({ tool_input: filePath ? { file_path: filePath } : {} });
}

describe("identity reload hook", () => {
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
    // A later identity edit must not re-arm the latch either.
    await fire(hook, "VOLUTE.md");
    assert.equal(shouldRequestReload(), false, "latch stays closed after the first request");
  });
});
