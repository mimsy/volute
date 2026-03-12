import type { Api, Model } from "@mariozechner/pi-ai";
import {
  complete,
  getEnvApiKey,
  getModel,
  getModels,
  getOAuthApiKey,
  getProviders,
} from "@mariozechner/pi-ai";
import log from "./logger.js";
import {
  type AiConfig,
  type AiProviderConfig,
  readGlobalConfig,
  writeGlobalConfig,
} from "./setup.js";

export type { AiConfig, AiProviderConfig } from "./setup.js";

const aiLog = log.child("ai-service");

export function getAiConfig(): AiConfig | null {
  const config = readGlobalConfig();
  if (!config.ai) return null;

  // Migrate old single-provider format
  const ai = config.ai as Record<string, unknown>;
  if ("provider" in ai && !("providers" in ai)) {
    const old = ai as { provider: string; apiKey?: string; oauth?: AiProviderConfig["oauth"] };
    const migrated: AiConfig = {
      providers: {
        [old.provider]: {
          ...(old.apiKey ? { apiKey: old.apiKey } : {}),
          ...(old.oauth ? { oauth: old.oauth } : {}),
        },
      },
    };
    writeGlobalConfig({ ...config, ai: migrated });
    return migrated;
  }

  return config.ai;
}

export function saveProviderConfig(providerId: string, providerConfig: AiProviderConfig): void {
  const ai = getAiConfig() ?? { providers: {} };
  ai.providers[providerId] = providerConfig;
  const config = readGlobalConfig();
  writeGlobalConfig({ ...config, ai });
}

export function removeProviderConfig(providerId: string): void {
  const ai = getAiConfig();
  if (!ai) return;
  delete ai.providers[providerId];
  const config = readGlobalConfig();
  if (Object.keys(ai.providers).length === 0) {
    delete config.ai;
  } else {
    config.ai = ai;
  }
  writeGlobalConfig(config);
}

export function removeAiConfig(): void {
  const config = readGlobalConfig();
  delete config.ai;
  writeGlobalConfig(config);
}

/** Returns provider IDs that have credentials (config or env var). */
export function getConfiguredProviders(): string[] {
  const ai = getAiConfig();
  const configured = new Set<string>();

  // Providers with explicit config
  if (ai) {
    for (const id of Object.keys(ai.providers)) {
      const p = ai.providers[id];
      if (p.apiKey || p.oauth) configured.add(id);
    }
  }

  // Providers with env var credentials
  for (const id of getProviders()) {
    if (!configured.has(id) && getEnvApiKey(id)) {
      configured.add(id);
    }
  }

  return [...configured];
}

export function isAiConfigured(): boolean {
  return getEnabledModels().length > 0;
}

/** Get the admin-configured list of enabled model IDs. */
export function getEnabledModels(): string[] {
  const ai = getAiConfig();
  return ai?.models ?? [];
}

/** Set the list of enabled model IDs. */
export function setEnabledModels(modelIds: string[]): void {
  const ai = getAiConfig() ?? { providers: {} };
  ai.models = modelIds.length > 0 ? modelIds : undefined;
  const config = readGlobalConfig();
  writeGlobalConfig({ ...config, ai });
}

/** Returns all models from configured providers. */
export function getAvailableModels(): Model<Api>[] {
  const providers = getConfiguredProviders();
  const models: Model<Api>[] = [];
  for (const provider of providers) {
    try {
      models.push(...getModels(provider as any));
    } catch {
      // Provider may not have models registered
    }
  }
  return models;
}

/** Resolve API key for a provider, checking OAuth → config → env var. */
async function resolveApiKey(providerId: string): Promise<string | undefined> {
  const ai = getAiConfig();
  const providerConfig = ai?.providers[providerId];

  if (providerConfig?.oauth) {
    try {
      const result = await getOAuthApiKey(providerId, {
        [providerId]: providerConfig.oauth,
      });
      if (result) {
        // Persist refreshed credentials
        if (result.newCredentials.access !== providerConfig.oauth.access) {
          saveProviderConfig(providerId, { ...providerConfig, oauth: result.newCredentials });
        }
        return result.apiKey;
      }
    } catch (err) {
      aiLog.warn(`OAuth key resolution failed for ${providerId}`, log.errorData(err));
    }
  }

  if (providerConfig?.apiKey) return providerConfig.apiKey;

  return getEnvApiKey(providerId) ?? undefined;
}

function findModel(modelId: string): Model<Api> | undefined {
  const providers = getConfiguredProviders();
  for (const provider of providers) {
    try {
      const model = getModel(provider as any, modelId as any);
      if (model) return model;
    } catch {
      // Try next
    }
  }
  // Prefix match fallback
  for (const provider of providers) {
    try {
      const found = getModels(provider as any).find((m) => m.id.startsWith(modelId));
      if (found) return found;
    } catch {
      // Try next
    }
  }
  return undefined;
}

/** Pick from admin-enabled models. Uses first enabled model. */
function autoSelectModel(): Model<Api> | undefined {
  const enabled = getEnabledModels();
  if (enabled.length === 0) return undefined;
  for (const id of enabled) {
    const model = findModel(id);
    if (model) return model;
  }
  return undefined;
}

export async function aiComplete(
  systemPrompt: string,
  userMessage: string,
  modelId?: string,
): Promise<string | null> {
  const model = modelId ? findModel(modelId) : autoSelectModel();
  if (!model) {
    if (modelId) aiLog.warn(`model not found: ${modelId}`);
    return null;
  }

  try {
    const apiKey = await resolveApiKey(model.provider);

    const response = await complete(
      model,
      {
        systemPrompt,
        messages: [{ role: "user", content: userMessage, timestamp: Date.now() }],
      },
      apiKey ? { apiKey } : undefined,
    );

    const text = response.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("");

    return text || null;
  } catch (err) {
    aiLog.error("completion failed", log.errorData(err));
    return null;
  }
}
