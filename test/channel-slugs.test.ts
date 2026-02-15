import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, it } from "node:test";
import {
  buildChannelSlug,
  readChannelMap,
  resolveChannelId as resolveChannelIdSdk,
  writeChannelEntry,
} from "../src/connectors/sdk.js";
import { resolveChannelId as resolveChannelIdEnv } from "../src/lib/channels.js";
import { stateDir } from "../src/lib/registry.js";
import { slugify } from "../src/lib/slugify.js";

// Test agent name — stateDir will resolve to VOLUTE_HOME/state/test-channel-agent
const TEST_AGENT = "test-channel-agent";

describe("slugify", () => {
  it("converts spaces to hyphens", () => {
    assert.equal(slugify("hello world"), "hello-world");
  });

  it("removes special characters", () => {
    assert.equal(slugify("hello!@#$%world"), "hello-world");
  });

  it("collapses multiple hyphens", () => {
    assert.equal(slugify("hello---world"), "hello-world");
  });

  it("trims leading and trailing hyphens", () => {
    assert.equal(slugify("--hello--"), "hello");
  });

  it("returns empty string for empty input", () => {
    assert.equal(slugify(""), "");
  });

  it("preserves numbers", () => {
    assert.equal(slugify("channel 123"), "channel-123");
  });

  it("lowercases uppercase letters", () => {
    assert.equal(slugify("Hello World"), "hello-world");
  });
});

describe("buildChannelSlug", () => {
  it("builds guild channel slug with server name", () => {
    const slug = buildChannelSlug("discord", {
      channelName: "general",
      serverName: "My Server",
    });
    assert.equal(slug, "discord:my-server/general");
  });

  it("builds DM slug with single recipient", () => {
    const slug = buildChannelSlug("discord", {
      isDM: true,
      recipients: ["Alice"],
    });
    assert.equal(slug, "discord:@alice");
  });

  it("builds group DM slug with sorted recipients", () => {
    const slug = buildChannelSlug("discord", {
      isDM: true,
      recipients: ["Charlie", "Alice", "Bob"],
    });
    assert.equal(slug, "discord:@alice,bob,charlie");
  });

  it("builds DM slug from senderName when no recipients", () => {
    const slug = buildChannelSlug("discord", {
      isDM: true,
      senderName: "Alice",
    });
    assert.equal(slug, "discord:@alice");
  });

  it("builds telegram group slug without server", () => {
    const slug = buildChannelSlug("telegram", {
      channelName: "My Group Chat",
    });
    assert.equal(slug, "telegram:my-group-chat");
  });

  it("falls back to platformId", () => {
    const slug = buildChannelSlug("discord", {
      platformId: "123456789",
    });
    assert.equal(slug, "discord:123456789");
  });

  it("falls back to platformId when no useful metadata", () => {
    const slug = buildChannelSlug("discord", {
      platformId: "999",
    });
    assert.equal(slug, "discord:999");
  });
});

describe("readChannelMap", () => {
  beforeEach(() => {
    // Ensure state dir exists for our test agent
    mkdirSync(stateDir(TEST_AGENT), { recursive: true });
  });

  it("returns empty object for missing file", () => {
    const map = readChannelMap("nonexistent-agent");
    assert.deepEqual(map, {});
  });

  it("returns parsed map for valid file", () => {
    const dir = stateDir(TEST_AGENT);
    const entry = { platformId: "123", platform: "discord", name: "general" };
    writeFileSync(
      join(dir, "channels.json"),
      JSON.stringify({ "discord:my-server/general": entry }),
    );
    const map = readChannelMap(TEST_AGENT);
    assert.deepEqual(map, { "discord:my-server/general": entry });
  });

  it("returns empty object for corrupt file", () => {
    const dir = stateDir(TEST_AGENT);
    writeFileSync(join(dir, "channels.json"), "not json");
    const map = readChannelMap(TEST_AGENT);
    assert.deepEqual(map, {});
  });
});

describe("writeChannelEntry", () => {
  it("creates file and writes entry", () => {
    const entry = {
      platformId: "123",
      platform: "discord",
      name: "general",
      server: "My Server",
      type: "channel" as const,
    };
    writeChannelEntry(TEST_AGENT, "discord:my-server/general", entry);
    const data = JSON.parse(readFileSync(join(stateDir(TEST_AGENT), "channels.json"), "utf-8"));
    assert.deepEqual(data["discord:my-server/general"], entry);
  });

  it("merges with existing entries", () => {
    const entry1 = { platformId: "123", platform: "discord", name: "general" };
    const entry2 = { platformId: "456", platform: "discord", name: "random" };
    writeChannelEntry(TEST_AGENT, "discord:my-server/general", entry1);
    writeChannelEntry(TEST_AGENT, "discord:my-server/random", entry2);
    const data = JSON.parse(readFileSync(join(stateDir(TEST_AGENT), "channels.json"), "utf-8"));
    assert.deepEqual(data["discord:my-server/general"], entry1);
    assert.deepEqual(data["discord:my-server/random"], entry2);
  });
});

describe("resolveChannelId (sdk)", () => {
  it("returns platformId for known slug", () => {
    const entry = { platformId: "123456", platform: "discord" };
    writeChannelEntry(TEST_AGENT, "discord:my-server/general", entry);
    const id = resolveChannelIdSdk(TEST_AGENT, "discord:my-server/general");
    assert.equal(id, "123456");
  });

  it("returns slug suffix for unknown slug", () => {
    const dir = stateDir(TEST_AGENT);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "channels.json"), JSON.stringify({}));
    const id = resolveChannelIdSdk(TEST_AGENT, "discord:my-server/general");
    assert.equal(id, "my-server/general");
  });

  it("returns slug suffix when file is missing", () => {
    const id = resolveChannelIdSdk("missing-agent", "discord:some-channel");
    assert.equal(id, "some-channel");
  });
});

describe("resolveChannelId (env-based)", () => {
  it("returns platformId for known slug when VOLUTE_AGENT is set", () => {
    const entry = { platformId: "123456", platform: "discord" };
    writeChannelEntry(TEST_AGENT, "discord:my-server/general", entry);
    const id = resolveChannelIdEnv({ VOLUTE_AGENT: TEST_AGENT }, "discord:my-server/general");
    assert.equal(id, "123456");
  });

  it("returns slug suffix when no VOLUTE_AGENT", () => {
    const id = resolveChannelIdEnv({}, "discord:my-server/general");
    assert.equal(id, "my-server/general");
  });

  it("returns slug suffix when channels.json missing", () => {
    const id = resolveChannelIdEnv({ VOLUTE_AGENT: "missing-agent" }, "discord:some-channel");
    assert.equal(id, "some-channel");
  });

  it("returns slug suffix when slug not in map", () => {
    const dir = stateDir(TEST_AGENT);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "channels.json"), JSON.stringify({}));
    const id = resolveChannelIdEnv({ VOLUTE_AGENT: TEST_AGENT }, "discord:unknown-channel");
    assert.equal(id, "unknown-channel");
  });

  it("returns full string when no colon present", () => {
    const id = resolveChannelIdEnv({}, "nocolon");
    assert.equal(id, "nocolon");
  });
});
