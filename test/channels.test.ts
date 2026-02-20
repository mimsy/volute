import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CHANNELS, getChannelDriver, getChannelProvider } from "../src/lib/channels.js";

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

  it("getChannelProvider with volute URI returns volute config", () => {
    const config = getChannelProvider("volute:abc-123");
    assert.equal(config.name, "volute");
    assert.equal(config.showToolCalls, true);
  });

  it("getChannelProvider with discord URI returns discord config", () => {
    const config = getChannelProvider("discord:456");
    assert.equal(config.name, "discord");
    assert.equal(config.showToolCalls, false);
  });

  it("getChannelProvider with slack URI returns slack config", () => {
    const config = getChannelProvider("slack:C123");
    assert.equal(config.name, "slack");
    assert.equal(config.displayName, "Slack");
    assert.equal(config.showToolCalls, false);
  });

  it("getChannelProvider with telegram URI returns telegram config", () => {
    const config = getChannelProvider("telegram:456");
    assert.equal(config.name, "telegram");
    assert.equal(config.displayName, "Telegram");
    assert.equal(config.showToolCalls, false);
  });

  it("getChannelProvider with mail URI returns mail config", () => {
    const config = getChannelProvider("mail:user@example.com");
    assert.equal(config.name, "mail");
    assert.equal(config.displayName, "Email");
    assert.equal(config.showToolCalls, false);
  });

  it("getChannelProvider with unknown platform auto-generates config", () => {
    const config = getChannelProvider("matrix:foo");
    assert.equal(config.name, "matrix");
    assert.equal(config.displayName, "matrix");
    assert.equal(config.showToolCalls, false);
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
