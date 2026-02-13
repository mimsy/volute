import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, it } from "node:test";
import {
  buildChannelSlug,
  readChannelMap,
  resolveChannelId as resolveChannelIdSdk,
  writeChannelEntry,
} from "../src/connectors/sdk.js";
import { resolveChannelId as resolveChannelIdEnv } from "../src/lib/channels.js";
import { slugify } from "../src/lib/slugify.js";

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
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "volute-channel-test-"));
  });

  it("returns empty object for missing file", () => {
    const map = readChannelMap(tmp);
    assert.deepEqual(map, {});
  });

  it("returns parsed map for valid file", () => {
    const voluteDir = join(tmp, ".volute");
    mkdirSync(voluteDir, { recursive: true });
    const entry = { platformId: "123", platform: "discord", name: "general" };
    writeFileSync(
      join(voluteDir, "channels.json"),
      JSON.stringify({ "discord:my-server/general": entry }),
    );
    const map = readChannelMap(tmp);
    assert.deepEqual(map, { "discord:my-server/general": entry });
  });

  it("returns empty object for corrupt file", () => {
    const voluteDir = join(tmp, ".volute");
    mkdirSync(voluteDir, { recursive: true });
    writeFileSync(join(voluteDir, "channels.json"), "not json");
    const map = readChannelMap(tmp);
    assert.deepEqual(map, {});
  });
});

describe("writeChannelEntry", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "volute-channel-test-"));
  });

  it("creates file and writes entry", () => {
    const entry = {
      platformId: "123",
      platform: "discord",
      name: "general",
      server: "My Server",
      type: "channel" as const,
    };
    writeChannelEntry(tmp, "discord:my-server/general", entry);
    const data = JSON.parse(readFileSync(join(tmp, ".volute", "channels.json"), "utf-8"));
    assert.deepEqual(data["discord:my-server/general"], entry);
  });

  it("merges with existing entries", () => {
    const entry1 = { platformId: "123", platform: "discord", name: "general" };
    const entry2 = { platformId: "456", platform: "discord", name: "random" };
    writeChannelEntry(tmp, "discord:my-server/general", entry1);
    writeChannelEntry(tmp, "discord:my-server/random", entry2);
    const data = JSON.parse(readFileSync(join(tmp, ".volute", "channels.json"), "utf-8"));
    assert.deepEqual(data["discord:my-server/general"], entry1);
    assert.deepEqual(data["discord:my-server/random"], entry2);
  });
});

describe("resolveChannelId (sdk)", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "volute-channel-test-"));
  });

  it("returns platformId for known slug", () => {
    const entry = { platformId: "123456", platform: "discord" };
    writeChannelEntry(tmp, "discord:my-server/general", entry);
    const id = resolveChannelIdSdk(tmp, "discord:my-server/general");
    assert.equal(id, "123456");
  });

  it("returns slug suffix for unknown slug", () => {
    const voluteDir = join(tmp, ".volute");
    mkdirSync(voluteDir, { recursive: true });
    writeFileSync(join(voluteDir, "channels.json"), JSON.stringify({}));
    const id = resolveChannelIdSdk(tmp, "discord:my-server/general");
    assert.equal(id, "my-server/general");
  });

  it("returns slug suffix when file is missing", () => {
    const id = resolveChannelIdSdk(tmp, "discord:some-channel");
    assert.equal(id, "some-channel");
  });
});

describe("resolveChannelId (env-based)", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "volute-channel-test-"));
  });

  it("returns platformId for known slug when VOLUTE_AGENT_DIR is set", () => {
    const entry = { platformId: "123456", platform: "discord" };
    writeChannelEntry(tmp, "discord:my-server/general", entry);
    const id = resolveChannelIdEnv({ VOLUTE_AGENT_DIR: tmp }, "discord:my-server/general");
    assert.equal(id, "123456");
  });

  it("returns slug suffix when no VOLUTE_AGENT_DIR", () => {
    const id = resolveChannelIdEnv({}, "discord:my-server/general");
    assert.equal(id, "my-server/general");
  });

  it("returns slug suffix when channels.json missing", () => {
    const id = resolveChannelIdEnv({ VOLUTE_AGENT_DIR: tmp }, "discord:some-channel");
    assert.equal(id, "some-channel");
  });

  it("returns slug suffix when slug not in map", () => {
    const voluteDir = join(tmp, ".volute");
    mkdirSync(voluteDir, { recursive: true });
    writeFileSync(join(voluteDir, "channels.json"), JSON.stringify({}));
    const id = resolveChannelIdEnv({ VOLUTE_AGENT_DIR: tmp }, "discord:unknown-channel");
    assert.equal(id, "unknown-channel");
  });

  it("returns full string when no colon present", () => {
    const id = resolveChannelIdEnv({}, "nocolon");
    assert.equal(id, "nocolon");
  });
});
