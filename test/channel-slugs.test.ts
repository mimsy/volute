import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildChannelSlug } from "../src/connectors/sdk.js";
import { buildVoluteSlug, slugify } from "../src/lib/slugify.js";

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
    assert.equal(slug, "@alice");
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
    assert.equal(slug1, "@mind2");
    assert.equal(slug2, "@mind1");
  });

  it("falls back to conversation ID when slugify produces empty string", () => {
    const slug = buildVoluteSlug({
      participants: [{ username: "bot" }, { username: "!!!" }],
      mindUsername: "bot",
      convTitle: null,
      conversationId: "conv-789",
    });
    assert.equal(slug, "conv-789");
  });

  it("uses @other slug for 3-participant conversations (non-channel)", () => {
    const slug = buildVoluteSlug({
      participants: [{ username: "bot" }, { username: "alice" }, { username: "bob" }],
      mindUsername: "bot",
      convTitle: "Project Chat",
      conversationId: "conv-abc",
    });
    // Without convType: "channel", falls through to DM slug using first non-mind participant
    assert.equal(slug, "@alice");
  });

  it("uses #name slug for channel conversations with 3+ participants", () => {
    const slug = buildVoluteSlug({
      participants: [{ username: "bot" }, { username: "alice" }, { username: "bob" }],
      mindUsername: "bot",
      convTitle: "Project Chat",
      conversationId: "conv-def",
      convType: "channel",
      convName: "project-chat",
    });
    assert.equal(slug, "#project-chat");
  });

  it("falls back to conversation ID for single-participant conversations", () => {
    const slug = buildVoluteSlug({
      participants: [{ username: "bot" }],
      mindUsername: "bot",
      convTitle: null,
      conversationId: "conv-solo",
    });
    assert.equal(slug, "conv-solo");
  });

  it("falls back to conversation ID with no participants and no title", () => {
    const slug = buildVoluteSlug({
      participants: [],
      mindUsername: "bot",
      convTitle: null,
      conversationId: "conv-empty",
    });
    assert.equal(slug, "conv-empty");
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
    assert.equal(slug, "#general");
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
    assert.equal(slug, "@alice");
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
    assert.equal(slug, "@alice");
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
