import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, it } from "node:test";
import { Hono } from "hono";
import {
  _resetConfigCache,
  configPath,
  readGlobalConfig,
  writeGlobalConfig,
} from "../packages/daemon/src/lib/config/setup.js";
import { voluteSystemDir } from "../packages/daemon/src/lib/mind/registry.js";
import setup from "../packages/daemon/src/web/api/setup.js";

// 1x1 transparent PNG
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function createApp() {
  const app = new Hono();
  app.route("/api/setup", setup);
  return app;
}

function clearConfig() {
  _resetConfigCache();
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

  it("POST /api/setup/spirit — stores name and temperament", async () => {
    writeGlobalConfig({
      name: "test",
      setup: { type: "local", mindsDir: "/tmp/minds", isolation: "sandbox", service: false },
      setupCompleted: false,
    });
    const app = createApp();
    const res = await app.request("/api/setup/spirit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "iris", temperament: "warm, wry" }),
    });
    assert.equal(res.status, 200);

    const config = readGlobalConfig();
    assert.equal(config.setup?.spiritName, "iris");
    assert.equal(config.setup?.spiritTemperament, "warm, wry");

    // Status now offers the name for wizard resume
    const status = await app.request("/api/setup/status");
    const body = await status.json();
    assert.equal(body.spiritName, "iris");
  });

  it("POST /api/setup/spirit — rejects invalid names", async () => {
    writeGlobalConfig({
      name: "test",
      setup: { type: "local", mindsDir: "/tmp/minds", isolation: "sandbox", service: false },
      setupCompleted: false,
    });
    const app = createApp();
    for (const name of ["", "system", "has spaces", "-dash"]) {
      const res = await app.request("/api/setup/spirit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(name)}`);
    }
  });

  it("POST /api/setup/spirit — stashes an uploaded avatar and description", async () => {
    writeGlobalConfig({
      name: "test",
      setup: { type: "local", mindsDir: "/tmp/minds", isolation: "sandbox", service: false },
      setupCompleted: false,
    });
    const app = createApp();
    const res = await app.request("/api/setup/spirit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "iris",
        temperament: "gentle",
        description: "the quiet keeper of this house",
        avatar: `data:image/png;base64,${PNG_B64}`,
      }),
    });
    assert.equal(res.status, 200);

    const config = readGlobalConfig();
    assert.equal(config.setup?.spiritDescription, "the quiet keeper of this house");
    assert.equal(config.setup?.spiritAvatar, "spirit-avatar.png");
    const stashed = resolve(voluteSystemDir(), "spirit-avatar.png");
    assert.ok(existsSync(stashed));
    assert.equal(readFileSync(stashed).toString("base64"), PNG_B64);
    rmSync(stashed);
  });

  it("POST /api/setup/spirit — rejects a non-image data URI", async () => {
    writeGlobalConfig({
      name: "test",
      setup: { type: "local", mindsDir: "/tmp/minds", isolation: "sandbox", service: false },
      setupCompleted: false,
    });
    const app = createApp();
    const res = await app.request("/api/setup/spirit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "iris", avatar: "data:text/html;base64,PGI+" }),
    });
    assert.equal(res.status, 400);
  });

  it("POST /api/setup/spirit — requires the system step first", async () => {
    const app = createApp();
    const res = await app.request("/api/setup/spirit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "iris" }),
    });
    assert.equal(res.status, 400);
  });

  it("POST /api/setup/spirit — rejects after setup is complete", async () => {
    writeGlobalConfig({
      name: "test",
      setup: { type: "local", mindsDir: "/tmp/minds", isolation: "sandbox", service: false },
      setupCompleted: true,
    });
    const app = createApp();
    const res = await app.request("/api/setup/spirit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "iris" }),
    });
    assert.equal(res.status, 400);
  });

  it("POST /api/setup/models — rejects empty model list", async () => {
    const app = createApp();
    const res = await app.request("/api/setup/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ models: [], spiritModel: "anthropic:claude-sonnet-4" }),
    });
    assert.equal(res.status, 400);
  });

  it("POST /api/setup/models — rejects missing spirit model", async () => {
    const app = createApp();
    const res = await app.request("/api/setup/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ models: ["anthropic:claude-sonnet-4"], spiritModel: "" }),
    });
    assert.equal(res.status, 400);
  });
});
