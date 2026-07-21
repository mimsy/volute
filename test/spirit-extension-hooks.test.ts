import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import type { ExtensionManifest } from "@volute/extensions";

import {
  initMindManager,
  tryGetMindManager,
} from "../packages/daemon/src/lib/daemon/mind-manager.js";
import { startSpiritFull, stopSpiritFull } from "../packages/daemon/src/lib/daemon/mind-service.js";
import { initScheduler } from "../packages/daemon/src/lib/daemon/scheduler.js";
import {
  _clearLoadedExtensionsForTest,
  _registerExtensionForTest,
} from "../packages/daemon/src/lib/extensions.js";
import { addSpirit, removeMind } from "../packages/daemon/src/lib/mind/registry.js";

/**
 * The spirit is a mind: a registry row with a directory, its own pages, notes and
 * intentions. But it starts through startSpiritFull, which for a long time skipped
 * `notifyExtensionsMindStart` entirely — so the spirit received *no* extension
 * mind-start hook of any kind. The visible casualty was the pages extension, which
 * provisions each mind's shared-pages git worktree in `onMindStart`: the spirit
 * never got one, so `volute pages publish --shared` could never succeed for the one
 * mind whose job is tending the commons (#795).
 */
describe("spirit lifecycle fires extension mind hooks", () => {
  const spiritName = "spirit-hooks-test";
  let dataDir: string;
  const started: string[] = [];
  const stopped: string[] = [];

  before(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "spirit-hooks-"));
    mkdirSync(resolve(dataDir, "home/.config"), { recursive: true });
    await addSpirit(spiritName, 4997, "claude", dataDir);

    initScheduler();
    const manager = tryGetMindManager() ?? initMindManager();
    // Spawning a real mind process is e2e territory; this test is about what the
    // lifecycle notifies, not what it spawns.
    manager.startMind = async () => {};
    manager.stopMind = async () => {};

    _clearLoadedExtensionsForTest();
    _registerExtensionForTest({
      id: "hook-spy",
      name: "Hook Spy",
      version: "0",
      onMindStart: (name: string) => {
        started.push(name);
      },
      onMindStop: (name: string) => {
        stopped.push(name);
      },
    } as unknown as ExtensionManifest);
  });

  after(async () => {
    _clearLoadedExtensionsForTest();
    await removeMind(spiritName).catch(() => {});
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("notifies extensions when the spirit starts", async () => {
    await startSpiritFull(spiritName);
    assert.deepEqual(started, [spiritName]);
  });

  it("notifies extensions when the spirit stops", async () => {
    await stopSpiritFull(spiritName);
    assert.deepEqual(stopped, [spiritName]);
  });
});
