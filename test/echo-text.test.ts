import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { clearEchoTextCache } from "../packages/daemon/src/lib/delivery/echo-text.js";
import { addMind, removeMind } from "../packages/daemon/src/lib/mind/registry.js";
import { readVoluteConfig } from "../packages/daemon/src/lib/mind/volute-config.js";

function createMindWithConfig(config: object): string {
  const port = 4100 + Math.floor(Math.random() * 1000);
  const name = `echo-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  addMind(name, port);
  const dir = resolve(process.env.VOLUTE_HOME!, "minds", name);
  const configDir = resolve(dir, "home/.config");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "volute.json"), JSON.stringify(config));
  return name;
}

describe("echoText config", () => {
  afterEach(() => clearEchoTextCache());

  it("reads echoText from volute.json", () => {
    const name = createMindWithConfig({ echoText: true });
    const config = readVoluteConfig(resolve(process.env.VOLUTE_HOME!, "minds", name));
    assert.equal(config?.echoText, true);
    removeMind(name);
  });

  it("defaults to undefined when not set", () => {
    const name = createMindWithConfig({});
    const config = readVoluteConfig(resolve(process.env.VOLUTE_HOME!, "minds", name));
    assert.equal(config?.echoText, undefined);
    removeMind(name);
  });
});
