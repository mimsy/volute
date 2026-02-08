import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CHANNELS, getChannelConfig } from "../src/lib/channels.js";

describe("channels", () => {
  it("CHANNELS has expected entries", () => {
    assert.ok(CHANNELS.web);
    assert.ok(CHANNELS.discord);
    assert.ok(CHANNELS.cli);
    assert.ok(CHANNELS.agent);
    assert.ok(CHANNELS.system);
    assert.equal(Object.keys(CHANNELS).length, 5);
  });

  it("getChannelConfig with no arg returns web config", () => {
    const config = getChannelConfig();
    assert.equal(config.name, "web");
  });

  it("getChannelConfig with web URI returns web config", () => {
    const config = getChannelConfig("web:123");
    assert.equal(config.name, "web");
    assert.equal(config.showToolCalls, true);
  });

  it("getChannelConfig with discord URI returns discord config", () => {
    const config = getChannelConfig("discord:456");
    assert.equal(config.name, "discord");
    assert.equal(config.showToolCalls, false);
  });

  it("getChannelConfig with cli URI returns cli config", () => {
    const config = getChannelConfig("cli:789");
    assert.equal(config.name, "cli");
    assert.equal(config.showToolCalls, true);
  });

  it("getChannelConfig with unknown platform falls back to web", () => {
    const config = getChannelConfig("unknown:foo");
    assert.equal(config.name, "web");
  });
});
