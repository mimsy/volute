import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CHANNELS, getChannelDriver, getChannelProvider } from "../src/lib/channels.js";

describe("channels", () => {
  it("CHANNELS has expected entries", () => {
    assert.ok(CHANNELS.web);
    assert.ok(CHANNELS.discord);
    assert.ok(CHANNELS.cli);
    assert.ok(CHANNELS.agent);
    assert.ok(CHANNELS.system);
    assert.equal(Object.keys(CHANNELS).length, 5);
  });

  it("getChannelProvider with no arg returns web config", () => {
    const config = getChannelProvider();
    assert.equal(config.name, "web");
  });

  it("getChannelProvider with web URI returns web config", () => {
    const config = getChannelProvider("web:123");
    assert.equal(config.name, "web");
    assert.equal(config.showToolCalls, true);
  });

  it("getChannelProvider with discord URI returns discord config", () => {
    const config = getChannelProvider("discord:456");
    assert.equal(config.name, "discord");
    assert.equal(config.showToolCalls, false);
  });

  it("getChannelProvider with cli URI returns cli config", () => {
    const config = getChannelProvider("cli:789");
    assert.equal(config.name, "cli");
    assert.equal(config.showToolCalls, true);
  });

  it("getChannelProvider with unknown platform auto-generates config", () => {
    const config = getChannelProvider("slack:foo");
    assert.equal(config.name, "slack");
    assert.equal(config.displayName, "slack");
    assert.equal(config.showToolCalls, false);
  });

  it("getChannelDriver returns driver for discord", () => {
    const driver = getChannelDriver("discord");
    assert.ok(driver);
    assert.equal(typeof driver.read, "function");
    assert.equal(typeof driver.send, "function");
  });

  it("getChannelDriver returns null for unknown platform", () => {
    const driver = getChannelDriver("unknown");
    assert.equal(driver, null);
  });

  it("getChannelDriver returns null for platforms without drivers", () => {
    const driver = getChannelDriver("web");
    assert.equal(driver, null);
  });
});
