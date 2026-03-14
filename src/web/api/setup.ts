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
  const config = readGlobalConfig();
  return c.json({ complete, config: complete ? config : undefined });
});

setup.post("/configure", async (c) => {
  if (isSetupComplete()) {
    return c.json({ error: "Setup already complete" }, 400);
  }

  const body = await c.req.json<{
    name: string;
    type?: SetupType;
    isolation?: IsolationMode;
  }>();

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

  mkdirSync(configHome, { recursive: true });
  mkdirSync(mindsDir, { recursive: true });

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

  writeGlobalConfig(config);

  return c.json({ ok: true, config });
});

export default setup;
