import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { after, before, describe, it, mock } from "node:test";
import { eq } from "drizzle-orm";
import { createUser } from "../packages/daemon/src/lib/auth.js";
import {
  getSpiritName,
  readGlobalConfig,
  writeGlobalConfig,
} from "../packages/daemon/src/lib/config/setup.js";
import {
  initMindManager,
  tryGetMindManager,
} from "../packages/daemon/src/lib/daemon/mind-manager.js";
import { getDb } from "../packages/daemon/src/lib/db.js";
import {
  addMind,
  addSpirit,
  mindDir,
  removeMind,
  voluteSystemDir,
} from "../packages/daemon/src/lib/mind/registry.js";
import { users } from "../packages/daemon/src/lib/schema.js";
import { createSession, deleteSession } from "../packages/daemon/src/web/middleware/auth.js";

/**
 * A mind's model and thinking level live only in home/.config/config.json — the file
 * the template runs from. A second copy in volute.json drifted from it and the
 * settings page believed the copy: bardo's spirit showed "haiku" while running
 * claude-sonnet-5.
 */

const ADMIN = "model-config-admin";
const MIND = "model-config-mind";

let cookie: string;
let spiritDir: string;
let spiritName: string;

function headers() {
  return {
    Cookie: `volute_session=${cookie}`,
    Origin: "http://localhost",
    "Content-Type": "application/json",
  };
}

async function request(method: string, path: string, body?: unknown) {
  const { default: app } = await import("../packages/daemon/src/web/app.js");
  return app.request(`http://localhost${path}`, {
    method,
    headers: headers(),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function writeJson(dir: string, rel: string, value: unknown): void {
  const path = resolve(dir, rel);
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(dir: string, rel: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(dir, rel), "utf-8"));
}

async function cleanup() {
  const db = await getDb();
  await db.delete(users).where(eq(users.username, ADMIN));
  for (const name of [MIND, spiritName]) {
    try {
      await removeMind(name);
    } catch {
      // not registered
    }
  }
  rmSync(mindDir(MIND), { recursive: true, force: true });
  if (spiritDir) rmSync(spiritDir, { recursive: true, force: true });
}

describe("a mind's model lives only in config.json", { concurrency: 1 }, () => {
  before(async () => {
    spiritName = getSpiritName();
    spiritDir = resolve(voluteSystemDir(), "model-config-spirit");
    await cleanup();
    const user = await createUser(ADMIN, "pass");
    cookie = await createSession(user.id);
  });

  after(async () => {
    if (cookie) await deleteSession(cookie);
    await cleanup();
    const config = readGlobalConfig();
    delete config.spiritModel;
    writeGlobalConfig(config);
  });

  it("reports config.json, not a stale volute.json copy", async () => {
    await addMind(MIND, 4830, undefined, "claude");
    const dir = mindDir(MIND);
    writeJson(dir, "home/.config/volute.json", { model: "haiku", thinkingLevel: "minimal" });
    writeJson(dir, "home/.config/config.json", { model: "claude-sonnet-5", effort: "high" });

    const res = await request("GET", `/api/v1/minds/${MIND}/config`);
    assert.equal(res.status, 200);
    const { config } = await res.json();
    assert.equal(config.model, "claude-sonnet-5");
    assert.equal(config.thinkingLevel, "high");
  });

  it("reports no thinking level when config.json sets none", async () => {
    const dir = mindDir(MIND);
    writeJson(dir, "home/.config/config.json", { model: "claude-sonnet-5" });

    const { config } = await (await request("GET", `/api/v1/minds/${MIND}/config`)).json();
    assert.equal(config.thinkingLevel, null, "volute.json's stale 'minimal' must not show");
  });

  // The read is synchronous on the event loop: a FIFO the mind planted at config.json
  // must be refused, not block every mind's requests (#1272 review).
  it("reports no model rather than hanging on a FIFO at config.json", async () => {
    const dir = mindDir(MIND);
    const path = resolve(dir, "home/.config/config.json");
    rmSync(path);
    execFileSync("mkfifo", [path]);
    try {
      const res = await request("GET", `/api/v1/minds/${MIND}/config`);
      assert.equal(res.status, 200);
      assert.equal((await res.json()).config.model, null);
    } finally {
      rmSync(path);
    }
  });

  it("saves model and thinking level to config.json only", async () => {
    const dir = mindDir(MIND);
    writeJson(dir, "home/.config/volute.json", {});

    const res = await request("PUT", `/api/v1/minds/${MIND}/config`, {
      model: "claude-opus-5-5",
      thinkingLevel: "medium",
    });
    assert.equal(res.status, 200);

    const sdk = readJson(dir, "home/.config/config.json");
    assert.equal(sdk.model, "claude-opus-5-5");
    assert.equal(sdk.effort, "medium");
    const volute = readJson(dir, "home/.config/volute.json");
    assert.equal(volute.model, undefined);
    assert.equal(volute.thinkingLevel, undefined);
  });

  it("Settings' spirit model reaches the spirit's config.json", async () => {
    await addSpirit(spiritName, 4831, "claude", spiritDir);
    writeJson(spiritDir, "home/.config/config.json", { model: "claude-haiku-4-5" });

    const res = await request("PUT", "/api/v1/system/ai/defaults", {
      spiritModel: "anthropic:claude-sonnet-5",
    });
    assert.equal(res.status, 200);
    assert.equal(readJson(spiritDir, "home/.config/config.json").model, "claude-sonnet-5");
  });

  it("restarts a running spirit so the new model takes effect", async () => {
    writeJson(spiritDir, "home/.config/config.json", { model: "claude-haiku-4-5" });
    const manager = tryGetMindManager() ?? initMindManager();
    const running = mock.method(manager, "isRunning", (name: string) => name === spiritName);
    const restart = mock.method(manager, "restartMind", async () => {});
    try {
      await request("PUT", "/api/v1/system/ai/defaults", {
        spiritModel: "anthropic:claude-sonnet-5",
      });
      assert.deepEqual(
        restart.mock.calls.map((c) => c.arguments[0]),
        [spiritName],
      );

      // Saving the model it already runs is not a reason to interrupt it.
      await request("PUT", "/api/v1/system/ai/defaults", {
        spiritModel: "anthropic:claude-sonnet-5",
      });
      assert.equal(restart.mock.callCount(), 1);
    } finally {
      running.mock.restore();
      restart.mock.restore();
    }
  });

  it("leaves a model for another template to the next daemon start", async () => {
    writeJson(spiritDir, "home/.config/config.json", { model: "claude-sonnet-5" });

    const res = await request("PUT", "/api/v1/system/ai/defaults", {
      spiritModel: "openrouter:kimi-k2.5",
    });
    assert.equal(res.status, 200);
    assert.equal(
      readJson(spiritDir, "home/.config/config.json").model,
      "claude-sonnet-5",
      "a pi model id must not land in a claude spirit's config",
    );
    assert.equal(readGlobalConfig().spiritModel, "openrouter:kimi-k2.5");
  });
});
