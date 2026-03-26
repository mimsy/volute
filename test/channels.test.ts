import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isConversationId } from "../packages/daemon/src/lib/chat/typing.js";
import {
  getPlatform,
  getPlatformDriver,
  PLATFORMS,
  resolvePlatformId,
} from "../packages/daemon/src/lib/platforms.js";

describe("platforms", () => {
  it("PLATFORMS has expected entries", () => {
    assert.ok(PLATFORMS.volute);
    assert.ok(PLATFORMS.discord);
    assert.ok(PLATFORMS.slack);
    assert.ok(PLATFORMS.telegram);
    assert.ok(PLATFORMS.mail);
    assert.ok(PLATFORMS.system);
    assert.equal(Object.keys(PLATFORMS).length, 6);
  });

  it("volute platform is builtIn", () => {
    assert.equal(PLATFORMS.volute.builtIn, true);
  });

  it("non-volute platforms are not builtIn", () => {
    assert.equal(PLATFORMS.discord.builtIn, undefined);
    assert.equal(PLATFORMS.slack.builtIn, undefined);
    assert.equal(PLATFORMS.telegram.builtIn, undefined);
    assert.equal(PLATFORMS.mail.builtIn, undefined);
    assert.equal(PLATFORMS.system.builtIn, undefined);
  });

  it("getPlatform with no arg returns volute config", () => {
    const config = getPlatform();
    assert.equal(config.name, "volute");
  });

  it("getPlatform with bare slug returns volute config", () => {
    const config = getPlatform("@alice");
    assert.equal(config.name, "volute");
  });

  it("getPlatform with bare channel slug returns volute config", () => {
    const config = getPlatform("#general");
    assert.equal(config.name, "volute");
  });

  it("getPlatform with bare conversationId returns volute config", () => {
    const config = getPlatform("abc-123");
    assert.equal(config.name, "volute");
  });

  it("getPlatform with discord URI returns discord config", () => {
    const config = getPlatform("discord:456");
    assert.equal(config.name, "discord");
  });

  it("getPlatform with slack URI returns slack config", () => {
    const config = getPlatform("slack:C123");
    assert.equal(config.name, "slack");
    assert.equal(config.displayName, "Slack");
  });

  it("getPlatform with telegram URI returns telegram config", () => {
    const config = getPlatform("telegram:456");
    assert.equal(config.name, "telegram");
    assert.equal(config.displayName, "Telegram");
  });

  it("getPlatform with mail URI returns mail config", () => {
    const config = getPlatform("mail:user@example.com");
    assert.equal(config.name, "mail");
    assert.equal(config.displayName, "Email");
  });

  it("getPlatform with unknown platform auto-generates config", () => {
    const config = getPlatform("matrix:foo");
    assert.equal(config.name, "matrix");
    assert.equal(config.displayName, "matrix");
  });

  it("getPlatformDriver returns driver for volute", () => {
    const driver = getPlatformDriver("volute");
    assert.ok(driver);
    assert.equal(typeof driver.read, "function");
    assert.equal(typeof driver.send, "function");
  });

  it("getPlatformDriver returns driver for discord", () => {
    const driver = getPlatformDriver("discord");
    assert.ok(driver);
    assert.equal(typeof driver.read, "function");
    assert.equal(typeof driver.send, "function");
  });

  it("getPlatformDriver returns driver for slack", () => {
    const driver = getPlatformDriver("slack");
    assert.ok(driver);
    assert.equal(typeof driver.read, "function");
    assert.equal(typeof driver.send, "function");
  });

  it("getPlatformDriver returns driver for telegram", () => {
    const driver = getPlatformDriver("telegram");
    assert.ok(driver);
    assert.equal(typeof driver.read, "function");
    assert.equal(typeof driver.send, "function");
  });

  it("getPlatformDriver returns null for unknown platform", () => {
    const driver = getPlatformDriver("unknown");
    assert.equal(driver, null);
  });

  it("getPlatformDriver returns null for mail (no driver)", () => {
    const driver = getPlatformDriver("mail");
    assert.equal(driver, null);
  });

  it("getPlatformDriver returns null for system (no driver)", () => {
    const driver = getPlatformDriver("system");
    assert.equal(driver, null);
  });

  it("telegram read throws unsupported error", async () => {
    const driver = getPlatformDriver("telegram");
    assert.ok(driver);
    await assert.rejects(() => driver.read({}, "123", 10), {
      message: /does not support reading/,
    });
  });

  it("volute driver has listConversations, listUsers, createConversation", () => {
    const driver = getPlatformDriver("volute");
    assert.ok(driver);
    assert.equal(typeof driver.listConversations, "function");
    assert.equal(typeof driver.listUsers, "function");
    assert.equal(typeof driver.createConversation, "function");
  });

  it("discord driver has listConversations, listUsers, createConversation", () => {
    const driver = getPlatformDriver("discord");
    assert.ok(driver);
    assert.equal(typeof driver.listConversations, "function");
    assert.equal(typeof driver.listUsers, "function");
    assert.equal(typeof driver.createConversation, "function");
  });

  it("slack driver has listConversations, listUsers, createConversation", () => {
    const driver = getPlatformDriver("slack");
    assert.ok(driver);
    assert.equal(typeof driver.listConversations, "function");
    assert.equal(typeof driver.listUsers, "function");
    assert.equal(typeof driver.createConversation, "function");
  });

  it("telegram driver has listConversations, listUsers, createConversation that throw", async () => {
    const driver = getPlatformDriver("telegram");
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

describe("resolvePlatformId", () => {
  it("extracts part after colon for platform slugs", () => {
    assert.equal(resolvePlatformId("discord:my-server/general"), "my-server/general");
    assert.equal(resolvePlatformId("slack:workspace/channel"), "workspace/channel");
    assert.equal(resolvePlatformId("telegram:@user"), "@user");
  });

  it("returns full string for bare slugs", () => {
    assert.equal(resolvePlatformId("@alice"), "@alice");
    assert.equal(resolvePlatformId("#general"), "#general");
    assert.equal(resolvePlatformId("abc-123-def"), "abc-123-def");
  });

  it("handles multiple colons by splitting on first", () => {
    assert.equal(resolvePlatformId("slack:workspace:extra"), "workspace:extra");
  });

  it("handles empty string", () => {
    assert.equal(resolvePlatformId(""), "");
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
