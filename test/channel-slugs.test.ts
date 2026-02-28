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
import { buildVoluteSlug, slugify } from "../src/lib/slugify.js";

// Test mind name — stateDir will resolve to VOLUTE_HOME/state/test-channel-mind
const TEST_MIND = "test-channel-mind";

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

describe("buildVoluteSlug", () => {
  it("generates @username slug for the other participant in a DM", () => {
    const slug = buildVoluteSlug({
      participants: [{ username: "bot" }, { username: "alice" }],
      mindUsername: "bot",
      convTitle: "bot, alice",
      conversationId: "conv-123",
    });
    assert.equal(slug, "volute:@alice");
  });

  it("each mind in a multi-mind DM gets a different slug", () => {
    const participants = [{ username: "mind1" }, { username: "mind2" }];
    const slug1 = buildVoluteSlug({
      participants,
      mindUsername: "mind1",
      convTitle: null,
      conversationId: "conv-456",
    });
    const slug2 = buildVoluteSlug({
      participants,
      mindUsername: "mind2",
      convTitle: null,
      conversationId: "conv-456",
    });
    assert.equal(slug1, "volute:@mind2");
    assert.equal(slug2, "volute:@mind1");
  });

  it("falls back to conversation ID when slugify produces empty string", () => {
    const slug = buildVoluteSlug({
      participants: [{ username: "bot" }, { username: "!!!" }],
      mindUsername: "bot",
      convTitle: null,
      conversationId: "conv-789",
    });
    assert.equal(slug, "volute:conv-789");
  });

  it("uses title-based slug for group conversations", () => {
    const slug = buildVoluteSlug({
      participants: [{ username: "bot" }, { username: "alice" }, { username: "bob" }],
      mindUsername: "bot",
      convTitle: "Project Chat",
      conversationId: "conv-abc",
    });
    assert.equal(slug, "volute:project-chat");
  });

  it("falls back to conversation ID for untitled groups", () => {
    const slug = buildVoluteSlug({
      participants: [{ username: "bot" }, { username: "alice" }, { username: "bob" }],
      mindUsername: "bot",
      convTitle: null,
      conversationId: "conv-def",
    });
    assert.equal(slug, "volute:conv-def");
  });

  it("falls back to conversation ID for single-participant conversations", () => {
    const slug = buildVoluteSlug({
      participants: [{ username: "bot" }],
      mindUsername: "bot",
      convTitle: null,
      conversationId: "conv-solo",
    });
    assert.equal(slug, "volute:conv-solo");
  });

  it("falls back to conversation ID with no participants and no title", () => {
    const slug = buildVoluteSlug({
      participants: [],
      mindUsername: "bot",
      convTitle: null,
      conversationId: "conv-empty",
    });
    assert.equal(slug, "volute:conv-empty");
  });

  it("uses #channel-name slug for channel conversations", () => {
    const slug = buildVoluteSlug({
      participants: [{ username: "bot" }, { username: "alice" }],
      mindUsername: "bot",
      convTitle: "general",
      conversationId: "conv-ch1",
      convType: "channel",
      convName: "general",
    });
    assert.equal(slug, "volute:#general");
  });

  it("falls through to DM/group logic when channel has no name", () => {
    const slug = buildVoluteSlug({
      participants: [{ username: "bot" }, { username: "alice" }],
      mindUsername: "bot",
      convTitle: null,
      conversationId: "conv-ch2",
      convType: "channel",
      convName: undefined,
    });
    // No convName → falls through, 2 participants → DM slug
    assert.equal(slug, "volute:@alice");
  });

  it("does NOT use channel path for DM even when convName is set", () => {
    const slug = buildVoluteSlug({
      participants: [{ username: "bot" }, { username: "alice" }],
      mindUsername: "bot",
      convTitle: null,
      conversationId: "conv-ch3",
      convType: "dm",
      convName: "general",
    });
    // convType is "dm", not "channel" → should use DM slug
    assert.equal(slug, "volute:@alice");
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
    // Ensure state dir exists for our test mind
    mkdirSync(stateDir(TEST_MIND), { recursive: true });
  });

  it("returns empty object for missing file", () => {
    const map = readChannelMap("nonexistent-mind");
    assert.deepEqual(map, {});
  });

  it("returns parsed map for valid file", () => {
    const dir = stateDir(TEST_MIND);
    const entry = { platformId: "123", platform: "discord", name: "general" };
    writeFileSync(
      join(dir, "channels.json"),
      JSON.stringify({ "discord:my-server/general": entry }),
    );
    const map = readChannelMap(TEST_MIND);
    assert.deepEqual(map, { "discord:my-server/general": entry });
  });

  it("returns empty object for corrupt file", () => {
    const dir = stateDir(TEST_MIND);
    writeFileSync(join(dir, "channels.json"), "not json");
    const map = readChannelMap(TEST_MIND);
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
    writeChannelEntry(TEST_MIND, "discord:my-server/general", entry);
    const data = JSON.parse(readFileSync(join(stateDir(TEST_MIND), "channels.json"), "utf-8"));
    assert.deepEqual(data["discord:my-server/general"], entry);
  });

  it("merges with existing entries", () => {
    const entry1 = { platformId: "123", platform: "discord", name: "general" };
    const entry2 = { platformId: "456", platform: "discord", name: "random" };
    writeChannelEntry(TEST_MIND, "discord:my-server/general", entry1);
    writeChannelEntry(TEST_MIND, "discord:my-server/random", entry2);
    const data = JSON.parse(readFileSync(join(stateDir(TEST_MIND), "channels.json"), "utf-8"));
    assert.deepEqual(data["discord:my-server/general"], entry1);
    assert.deepEqual(data["discord:my-server/random"], entry2);
  });
});

describe("resolveChannelId (sdk)", () => {
  it("returns platformId for known slug", () => {
    const entry = { platformId: "123456", platform: "discord" };
    writeChannelEntry(TEST_MIND, "discord:my-server/general", entry);
    const id = resolveChannelIdSdk(TEST_MIND, "discord:my-server/general");
    assert.equal(id, "123456");
  });

  it("returns slug suffix for unknown slug", () => {
    const dir = stateDir(TEST_MIND);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "channels.json"), JSON.stringify({}));
    const id = resolveChannelIdSdk(TEST_MIND, "discord:my-server/general");
    assert.equal(id, "my-server/general");
  });

  it("returns slug suffix when file is missing", () => {
    const id = resolveChannelIdSdk("missing-mind", "discord:some-channel");
    assert.equal(id, "some-channel");
  });
});

describe("resolveChannelId (env-based)", () => {
  it("returns platformId for known slug when VOLUTE_MIND is set", () => {
    const entry = { platformId: "123456", platform: "discord" };
    writeChannelEntry(TEST_MIND, "discord:my-server/general", entry);
    const id = resolveChannelIdEnv({ VOLUTE_MIND: TEST_MIND }, "discord:my-server/general");
    assert.equal(id, "123456");
  });

  it("returns slug suffix when no VOLUTE_MIND", () => {
    const id = resolveChannelIdEnv({}, "discord:my-server/general");
    assert.equal(id, "my-server/general");
  });

  it("returns slug suffix when channels.json missing", () => {
    const id = resolveChannelIdEnv({ VOLUTE_MIND: "missing-mind" }, "discord:some-channel");
    assert.equal(id, "some-channel");
  });

  it("returns slug suffix when slug not in map", () => {
    const dir = stateDir(TEST_MIND);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "channels.json"), JSON.stringify({}));
    const id = resolveChannelIdEnv({ VOLUTE_MIND: TEST_MIND }, "discord:unknown-channel");
    assert.equal(id, "unknown-channel");
  });

  it("returns full string when no colon present", () => {
    const id = resolveChannelIdEnv({}, "nocolon");
    assert.equal(id, "nocolon");
  });
});
