import type { Api, Model } from "@mariozechner/pi-ai";
import { complete, getEnvApiKey, getModel, getModels, getProviders } from "@mariozechner/pi-ai";
import { getOAuthApiKey } from "@mariozechner/pi-ai/oauth";
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
  return config.ai ?? null;
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

/** Get the utility model ID (for turn summaries, consolidation, etc.). */
export function getUtilityModel(): string | undefined {
  const ai = getAiConfig();
  return ai?.utilityModel;
}

/** Set the utility model ID. */
export function setUtilityModel(modelId: string | undefined): void {
  const ai = getAiConfig() ?? { providers: {} };
  ai.utilityModel = modelId;
  const config = readGlobalConfig();
  writeGlobalConfig({ ...config, ai });
}

/** Complete using the utility model (falls back to default auto-selection). */
export async function aiCompleteUtility(
  systemPrompt: string,
  userMessage: string,
): Promise<string | null> {
  const utilityModel = getUtilityModel();
  return aiComplete(systemPrompt, userMessage, utilityModel);
}

/** Map a provider ID to its native template. */
function templateForProvider(provider: string): string {
  if (provider === "anthropic") return "claude";
  if (provider === "openai-codex") return "codex";
  return "pi";
}

/**
 * Resolve the best template for a given model ID.
 * Anthropic models → "claude", OpenAI Codex models → "codex", everything else → "pi".
 */
export function resolveTemplate(modelId?: string): string {
  if (!modelId) {
    // Check first enabled model's provider
    const enabled = getEnabledModels();
    if (enabled.length > 0) {
      const model = findModel(enabled[0]);
      if (model) return templateForProvider(model.provider);
    }
    // Check configured providers
    const providers = getConfiguredProviders();
    if (providers.length === 1) return templateForProvider(providers[0]);
    if (providers.length > 0 && !providers.includes("anthropic")) {
      return templateForProvider(providers[0]);
    }
    return "claude"; // default
  }
  // Parse provider from model ID (pi format: "provider:model-name")
  if (modelId.includes(":")) {
    const provider = modelId.split(":")[0];
    return templateForProvider(provider);
  }
  // Try to resolve the model to determine its provider
  const model = findModel(modelId);
  if (model) return templateForProvider(model.provider);
  // Unknown model without colon — default to claude
  return "claude";
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
    } catch (err) {
      aiLog.warn(`failed to load models for provider ${provider}`, log.errorData(err));
    }
  }
  return models;
}

/** Resolve API key for a provider, checking OAuth → config → env var. */
export async function resolveApiKey(providerId: string): Promise<string | undefined> {
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

/** Resolve a model ID to the full provider:model format needed by the pi template. */
export function qualifyModelId(modelId: string): string {
  if (modelId.includes(":")) return modelId;
  const model = findModel(modelId);
  if (model) return `${model.provider}:${model.id}`;
  return modelId;
}

function findModel(modelId: string): Model<Api> | undefined {
  const providers = getConfiguredProviders();
  for (const provider of providers) {
    try {
      const model = getModel(provider as any, modelId as any);
      if (model) return model;
    } catch (err) {
      aiLog.debug(`model lookup failed for ${modelId} in ${provider}`, log.errorData(err));
    }
  }
  // Prefix match fallback
  for (const provider of providers) {
    try {
      const found = getModels(provider as any).find((m) => m.id.startsWith(modelId));
      if (found) return found;
    } catch (err) {
      aiLog.debug(`prefix search failed for ${modelId} in ${provider}`, log.errorData(err));
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
    else aiLog.debug("no enabled model available for auto-selection");
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
