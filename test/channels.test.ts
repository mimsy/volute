import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CHANNELS,
  getChannelDriver,
  getChannelProvider,
  resolveChannelId,
} from "../src/lib/channels.js";
import { isConversationId } from "../src/lib/typing.js";

describe("channels", () => {
  it("CHANNELS has expected entries", () => {
    assert.ok(CHANNELS.volute);
    assert.ok(CHANNELS.discord);
    assert.ok(CHANNELS.slack);
    assert.ok(CHANNELS.telegram);
    assert.ok(CHANNELS.mail);
    assert.ok(CHANNELS.system);
    assert.equal(Object.keys(CHANNELS).length, 6);
  });

  it("volute channel is builtIn", () => {
    assert.equal(CHANNELS.volute.builtIn, true);
  });

  it("non-volute channels are not builtIn", () => {
    assert.equal(CHANNELS.discord.builtIn, undefined);
    assert.equal(CHANNELS.slack.builtIn, undefined);
    assert.equal(CHANNELS.telegram.builtIn, undefined);
    assert.equal(CHANNELS.mail.builtIn, undefined);
    assert.equal(CHANNELS.system.builtIn, undefined);
  });

  it("getChannelProvider with no arg returns volute config", () => {
    const config = getChannelProvider();
    assert.equal(config.name, "volute");
  });

  it("getChannelProvider with bare slug returns volute config", () => {
    const config = getChannelProvider("@alice");
    assert.equal(config.name, "volute");
  });

  it("getChannelProvider with bare channel slug returns volute config", () => {
    const config = getChannelProvider("#general");
    assert.equal(config.name, "volute");
  });

  it("getChannelProvider with bare conversationId returns volute config", () => {
    const config = getChannelProvider("abc-123");
    assert.equal(config.name, "volute");
  });

  it("getChannelProvider with discord URI returns discord config", () => {
    const config = getChannelProvider("discord:456");
    assert.equal(config.name, "discord");
  });

  it("getChannelProvider with slack URI returns slack config", () => {
    const config = getChannelProvider("slack:C123");
    assert.equal(config.name, "slack");
    assert.equal(config.displayName, "Slack");
  });

  it("getChannelProvider with telegram URI returns telegram config", () => {
    const config = getChannelProvider("telegram:456");
    assert.equal(config.name, "telegram");
    assert.equal(config.displayName, "Telegram");
  });

  it("getChannelProvider with mail URI returns mail config", () => {
    const config = getChannelProvider("mail:user@example.com");
    assert.equal(config.name, "mail");
    assert.equal(config.displayName, "Email");
  });

  it("getChannelProvider with unknown platform auto-generates config", () => {
    const config = getChannelProvider("matrix:foo");
    assert.equal(config.name, "matrix");
    assert.equal(config.displayName, "matrix");
  });

  it("getChannelDriver returns driver for volute", () => {
    const driver = getChannelDriver("volute");
    assert.ok(driver);
    assert.equal(typeof driver.read, "function");
    assert.equal(typeof driver.send, "function");
  });

  it("getChannelDriver returns driver for discord", () => {
    const driver = getChannelDriver("discord");
    assert.ok(driver);
    assert.equal(typeof driver.read, "function");
    assert.equal(typeof driver.send, "function");
  });

  it("getChannelDriver returns driver for slack", () => {
    const driver = getChannelDriver("slack");
    assert.ok(driver);
    assert.equal(typeof driver.read, "function");
    assert.equal(typeof driver.send, "function");
  });

  it("getChannelDriver returns driver for telegram", () => {
    const driver = getChannelDriver("telegram");
    assert.ok(driver);
    assert.equal(typeof driver.read, "function");
    assert.equal(typeof driver.send, "function");
  });

  it("getChannelDriver returns null for unknown platform", () => {
    const driver = getChannelDriver("unknown");
    assert.equal(driver, null);
  });

  it("getChannelDriver returns null for mail (no driver)", () => {
    const driver = getChannelDriver("mail");
    assert.equal(driver, null);
  });

  it("getChannelDriver returns null for system (no driver)", () => {
    const driver = getChannelDriver("system");
    assert.equal(driver, null);
  });

  it("telegram read throws unsupported error", async () => {
    const driver = getChannelDriver("telegram");
    assert.ok(driver);
    await assert.rejects(() => driver.read({}, "123", 10), {
      message: /does not support reading/,
    });
  });

  it("volute driver has listConversations, listUsers, createConversation", () => {
    const driver = getChannelDriver("volute");
    assert.ok(driver);
    assert.equal(typeof driver.listConversations, "function");
    assert.equal(typeof driver.listUsers, "function");
    assert.equal(typeof driver.createConversation, "function");
  });

  it("discord driver has listConversations, listUsers, createConversation", () => {
    const driver = getChannelDriver("discord");
    assert.ok(driver);
    assert.equal(typeof driver.listConversations, "function");
    assert.equal(typeof driver.listUsers, "function");
    assert.equal(typeof driver.createConversation, "function");
  });

  it("slack driver has listConversations, listUsers, createConversation", () => {
    const driver = getChannelDriver("slack");
    assert.ok(driver);
    assert.equal(typeof driver.listConversations, "function");
    assert.equal(typeof driver.listUsers, "function");
    assert.equal(typeof driver.createConversation, "function");
  });

  it("telegram driver has listConversations, listUsers, createConversation that throw", async () => {
    const driver = getChannelDriver("telegram");
    assert.ok(driver);
    assert.equal(typeof driver.listConversations, "function");
    assert.equal(typeof driver.listUsers, "function");
    assert.equal(typeof driver.createConversation, "function");
    await assert.rejects(() => driver.listConversations!({} as Record<string, string>), {
      message: /does not support listing conversations/,
    });
    await assert.rejects(() => driver.listUsers!({} as Record<string, string>), {
      message: /does not support listing users/,
    });
    await assert.rejects(() => driver.createConversation!({} as Record<string, string>, []), {
      message: /does not support creating conversations/,
    });
  });
});

describe("resolveChannelId", () => {
  it("extracts part after colon for platform slugs", () => {
    assert.equal(resolveChannelId("discord:my-server/general"), "my-server/general");
    assert.equal(resolveChannelId("slack:workspace/channel"), "workspace/channel");
    assert.equal(resolveChannelId("telegram:@user"), "@user");
  });

  it("returns full string for bare slugs", () => {
    assert.equal(resolveChannelId("@alice"), "@alice");
    assert.equal(resolveChannelId("#general"), "#general");
    assert.equal(resolveChannelId("abc-123-def"), "abc-123-def");
  });

  it("handles multiple colons by splitting on first", () => {
    assert.equal(resolveChannelId("slack:workspace:extra"), "workspace:extra");
  });

  it("handles empty string", () => {
    assert.equal(resolveChannelId(""), "");
  });
});

describe("isConversationId", () => {
  it("returns true for UUID-like conversation IDs", () => {
    assert.equal(isConversationId("abc-123-def-456"), true);
    assert.equal(isConversationId("550e8400-e29b-41d4-a716-446655440000"), true);
  });

  it("returns false for DM slugs", () => {
    assert.equal(isConversationId("@alice"), false);
  });

  it("returns false for channel slugs", () => {
    assert.equal(isConversationId("#general"), false);
  });

  it("returns false for platform-prefixed slugs", () => {
    assert.equal(isConversationId("discord:my-server/general"), false);
    assert.equal(isConversationId("slack:workspace/channel"), false);
  });

  it("returns false for slugs with slashes", () => {
    assert.equal(isConversationId("server/channel"), false);
  });

  it("returns true for empty string", () => {
    assert.equal(isConversationId(""), true);
  });
});
