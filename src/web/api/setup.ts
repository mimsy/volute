import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { Hono } from "hono";
import {
  type GlobalConfig,
  type IsolationMode,
  isSetupComplete,
  readGlobalConfig,
  type SetupConfig,
  type SetupType,
  writeGlobalConfig,
} from "../../lib/setup.js";

const setup = new Hono();

setup.get("/status", (c) => {
  const complete = isSetupComplete();
  if (!complete) {
    return c.json({ complete });
  }
  const config = readGlobalConfig();
  return c.json({
    complete,
    config: { name: config.name, setup: config.setup },
  });
});

setup.post("/configure", async (c) => {
  if (isSetupComplete()) {
    return c.json({ error: "Setup already complete" }, 400);
  }

  let body: { name: string; type?: SetupType; isolation?: IsolationMode };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON in request body" }, 400);
  }

  if (!body.name?.trim()) {
    return c.json({ error: "System name is required" }, 400);
  }

  const setupType: SetupType = body.type ?? "local";
  const isolation: IsolationMode = body.isolation ?? "sandbox";

  // Local setup only — system setup requires CLI with root
  if (setupType !== "local") {
    return c.json({ error: "Web setup only supports local install type" }, 400);
  }

  const configHome = process.env.VOLUTE_HOME ?? resolve(homedir(), ".volute");
  const mindsDir = resolve(configHome, "minds");

  try {
    mkdirSync(configHome, { recursive: true });
    mkdirSync(mindsDir, { recursive: true });
  } catch (err) {
    return c.json({ error: `Failed to create directories: ${(err as Error).message}` }, 500);
  }

  const existingConfig = readGlobalConfig();
  const setupConfig: SetupConfig = {
    type: setupType,
    mindsDir,
    isolation,
    service: false,
  };

  const config: GlobalConfig = {
    ...existingConfig,
    name: body.name.trim(),
    setup: setupConfig,
  };

  try {
    writeGlobalConfig(config);
  } catch (err) {
    return c.json({ error: `Failed to write configuration: ${(err as Error).message}` }, 500);
  }

  return c.json({ ok: true, config: { name: config.name, setup: config.setup } });
});

export default setup;
