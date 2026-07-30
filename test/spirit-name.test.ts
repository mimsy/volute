import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { afterEach, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { getOrCreateMindUser, getOrCreateSystemUser } from "../packages/daemon/src/lib/auth.js";
import {
  _resetConfigCache,
  configPath,
  getSpiritName,
  readGlobalConfig,
  type SetupConfig,
  writeGlobalConfig,
} from "../packages/daemon/src/lib/config/setup.js";
import { getDb } from "../packages/daemon/src/lib/db.js";
import {
  isSpiritName,
  validateMindName,
  validateSpiritName,
} from "../packages/daemon/src/lib/mind/registry.js";
import { users } from "../packages/daemon/src/lib/schema.js";

const BASE_SETUP: SetupConfig = {
  type: "local",
  mindsDir: "/tmp/minds",
  isolation: "none",
  service: false,
};

function setSpiritName(name: string | undefined) {
  const config = readGlobalConfig();
  writeGlobalConfig({ ...config, setup: { ...BASE_SETUP, spiritName: name } });
}

function clearConfig() {
  _resetConfigCache();
  if (existsSync(configPath())) rmSync(configPath());
}

describe("getSpiritName / isSpiritName", () => {
  afterEach(clearConfig);

  it("defaults to volute with no config", () => {
    clearConfig();
    assert.equal(getSpiritName(), "volute");
    assert.equal(isSpiritName("volute"), true);
    assert.equal(isSpiritName("iris"), false);
  });

  it("defaults to volute when setup exists without spiritName", () => {
    setSpiritName(undefined);
    assert.equal(getSpiritName(), "volute");
  });

  it("returns the configured name", () => {
    setSpiritName("iris");
    assert.equal(getSpiritName(), "iris");
    assert.equal(isSpiritName("iris"), true);
    assert.equal(isSpiritName("volute"), false);
  });
});

describe("name validation with a named spirit", () => {
  afterEach(clearConfig);

  it("validateMindName rejects the configured spirit name", () => {
    setSpiritName("iris");
    assert.ok(validateMindName("iris"));
    assert.equal(validateMindName("other-mind"), null);
    // The default reserved name stays reserved even when the spirit is renamed
    assert.ok(validateMindName("volute"));
  });

  it("validateSpiritName accepts volute and normal names", () => {
    assert.equal(validateSpiritName("volute"), null);
    assert.equal(validateSpiritName("iris"), null);
    assert.equal(validateSpiritName("Wren-2"), null);
  });

  it("validateSpiritName rejects bad names", () => {
    assert.ok(validateSpiritName(""));
    assert.ok(validateSpiritName("system"));
    assert.ok(validateSpiritName("-leading-dash"));
    assert.ok(validateSpiritName("has spaces"));
    assert.ok(validateSpiritName("x".repeat(65)));
  });
});

describe("system user follows the spirit name", () => {
  async function deleteSystemUsers() {
    const db = await getDb();
    await db.delete(users).where(eq(users.user_type, "spirit"));
  }

  afterEach(async () => {
    await deleteSystemUsers();
    clearConfig();
  });

  it("renames the boot-created system user after the spirit is named", async () => {
    await deleteSystemUsers();
    clearConfig();

    // Daemon boot: system user created under the default name
    const before = await getOrCreateSystemUser();
    assert.equal(before.username, "volute");

    // Host names the spirit during setup
    setSpiritName("iris");

    const after = await getOrCreateSystemUser();
    assert.equal(after.id, before.id, "same user, renamed");
    assert.equal(after.username, "iris");
    assert.equal(after.user_type, "spirit");
  });

  it("getOrCreateMindUser returns the system user for the spirit name", async () => {
    await deleteSystemUsers();
    setSpiritName("iris");

    const systemUser = await getOrCreateSystemUser();
    const mindUser = await getOrCreateMindUser("iris");
    assert.equal(mindUser.id, systemUser.id);
    assert.equal(mindUser.user_type, "spirit");
  });
});
