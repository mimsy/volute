import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  evaluateSeedChecklist,
  isMemoryWritten,
  isSoulWritten,
} from "../packages/daemon/src/lib/mind/seed-readiness.js";
import {
  MEMORY_PLACEHOLDER_MARKER,
  ORIENTATION_MARKER,
} from "../packages/daemon/src/lib/prompts.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const PLACEHOLDER_MEMORY = readFileSync(
  resolve(here, "../templates/_base/.init/MEMORY.md"),
  "utf-8",
);

describe("seed readiness predicates", () => {
  it("isSoulWritten is false while the orientation marker remains", () => {
    assert.equal(isSoulWritten(`I am a seed ${ORIENTATION_MARKER}.`), false);
    assert.equal(isSoulWritten("# Me\nA real identity."), true);
  });

  it("isMemoryWritten rejects empty and the placeholder", () => {
    assert.equal(isMemoryWritten("   \n"), false);
    assert.equal(isMemoryWritten(PLACEHOLDER_MEMORY), false);
    assert.equal(isMemoryWritten(`text ${MEMORY_PLACEHOLDER_MARKER}.`), false);
    assert.equal(isMemoryWritten("# Memory\nReal memories."), true);
  });
});

describe("evaluateSeedChecklist", () => {
  let dir: string;

  function writeConfig(config: unknown) {
    mkdirSync(resolve(dir, "home/.config"), { recursive: true });
    writeFileSync(resolve(dir, "home/.config/volute.json"), JSON.stringify(config));
  }

  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), "seed-readiness-"));
    mkdirSync(resolve(dir, "home"), { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("treats a fresh seed (marker SOUL, placeholder MEMORY, no profile) as unwritten", () => {
    writeFileSync(resolve(dir, "home/SOUL.md"), `Seed — ${ORIENTATION_MARKER}.`);
    writeFileSync(resolve(dir, "home/MEMORY.md"), PLACEHOLDER_MEMORY);
    writeConfig({});

    const c = evaluateSeedChecklist(dir);
    assert.equal(c.soulWritten, false);
    assert.equal(c.memoryWritten, false);
    assert.equal(c.displayNameSet, false);
    assert.equal(c.avatarSet, false);
  });

  it("treats a written seed as ready", () => {
    writeFileSync(resolve(dir, "home/SOUL.md"), "# Me\nA real identity.");
    writeFileSync(resolve(dir, "home/MEMORY.md"), "# Memory\nReal memories.");
    writeConfig({ profile: { displayName: "Iris" } });

    const c = evaluateSeedChecklist(dir);
    assert.equal(c.soulWritten, true);
    assert.equal(c.memoryWritten, true);
    assert.equal(c.displayNameSet, true);
  });

  it("counts the avatar only when its file actually exists (matches the sprout gate)", () => {
    writeConfig({ profile: { displayName: "Iris", avatar: "images/me.png" } });
    // Field set but no file on disk → not satisfied.
    assert.equal(evaluateSeedChecklist(dir).avatarSet, false);

    // Create the file → satisfied.
    mkdirSync(resolve(dir, "home/images"), { recursive: true });
    writeFileSync(resolve(dir, "home/images/me.png"), "png");
    assert.equal(evaluateSeedChecklist(dir).avatarSet, true);
  });

  it("does not count an avatar path that escapes the mind directory", () => {
    writeConfig({ profile: { avatar: "../../../etc/hosts" } });
    assert.equal(evaluateSeedChecklist(dir).avatarSet, false);
  });
});
