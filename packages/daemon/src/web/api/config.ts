import { Hono } from "hono";
import {
  getAvailableModels,
  getConfiguredProviders,
  getEnabledModels,
} from "../../lib/ai-service.js";
import { readGlobalConfig } from "../../lib/config/setup.js";

const config = new Hono();

config.get("/models", async (c) => {
  const enabled = new Set(getEnabledModels());
  const all = await getAvailableModels();
  const models = all.map((m) => ({
    id: m.id,
    name: m.name,
    provider: m.provider,
    enabled: enabled.has(`${m.provider}:${m.id}`),
  }));
  return c.json(models);
});

config.get("/providers", async (c) => {
  const configured = await getConfiguredProviders();
  return c.json(configured.map((id) => ({ id, configured: true })));
});

config.get("/status", (c) => {
  const globalConfig = readGlobalConfig();
  return c.json({
    name: globalConfig.name ?? "Volute",
    spiritModel: globalConfig.spiritModel ?? null,
    setupComplete: globalConfig.setupCompleted ?? false,
  });
});

export default config;
