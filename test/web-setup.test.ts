import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { beforeEach, describe, it } from "node:test";
import { Hono } from "hono";
import {
  configPath,
  readGlobalConfig,
  writeGlobalConfig,
} from "../packages/daemon/src/lib/config/setup.js";
import setup from "../packages/daemon/src/web/api/setup.js";

function createApp() {
  const app = new Hono();
  app.route("/api/setup", setup);
  return app;
}

function clearConfig() {
  const path = configPath();
  if (existsSync(path)) rmSync(path);
}

describe("web setup routes", () => {
  beforeEach(clearConfig);

  it("GET /api/setup/status — reports incomplete when no config", async () => {
    const app = createApp();
    const res = await app.request("/api/setup/status");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.complete, false);
    assert.equal(body.config, undefined);
  });

  it("GET /api/setup/status — reports complete after setup", async () => {
    writeGlobalConfig({
      name: "test",
      setup: { type: "local", mindsDir: "/tmp/minds", isolation: "sandbox", service: false },
      setupCompleted: true,
    });
    const app = createApp();
    const res = await app.request("/api/setup/status");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.complete, true);
    assert.ok(body.config);
  });

  it("POST /api/setup/configure — creates config", async () => {
    const app = createApp();
    const res = await app.request("/api/setup/configure", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "my-system" }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.config.name, "my-system");
    assert.equal(body.config.setup.type, "local");
    assert.equal(body.config.setup.isolation, "sandbox");

    // Verify config was written
    const config = readGlobalConfig();
    assert.equal(config.name, "my-system");
  });

  it("POST /api/setup/configure — rejects empty name", async () => {
    const app = createApp();
    const res = await app.request("/api/setup/configure", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "" }),
    });
    assert.equal(res.status, 400);
  });

  it("POST /api/setup/configure — rejects duplicate setup", async () => {
    writeGlobalConfig({
      name: "test",
      setup: { type: "local", mindsDir: "/tmp/minds", isolation: "sandbox", service: false },
      setupCompleted: true,
    });
    const app = createApp();
    const res = await app.request("/api/setup/configure", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "another" }),
    });
    assert.equal(res.status, 400);
  });

  it("POST /api/setup/configure — rejects system type", async () => {
    const app = createApp();
    const res = await app.request("/api/setup/configure", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "test", type: "system" }),
    });
    assert.equal(res.status, 400);
  });
});
