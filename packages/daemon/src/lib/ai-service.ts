import { type Api, defaultProviderAuthContext, type Model } from "@earendil-works/pi-ai";
import { getOAuthApiKey } from "@earendil-works/pi-ai/oauth";
import {
  builtinModels,
  getBuiltinModel,
  getBuiltinModels,
  getBuiltinProviders,
} from "@earendil-works/pi-ai/providers/all";
import {
  type AiConfig,
  type AiProviderConfig,
  readGlobalConfig,
  writeGlobalConfig,
} from "./config/setup.js";
import log from "./util/logger.js";

export type { AiConfig, AiProviderConfig } from "./config/setup.js";

const aiLog = log.child("ai-service");

// One Models collection with every built-in provider registered. Used for
// completion (auth resolved from the apiKey we pass in options) and for
// provider auth introspection. Catalog reads go through the static
// getBuiltin* helpers so they stay synchronous.
const models = builtinModels();
const authContext = defaultProviderAuthContext();

/**
 * Resolve a provider's API key from an optional stored config key merged with
 * ambient sources (env vars, AWS profiles, ADC files) via the provider's own
 * auth. Replaces the old getEnvApiKey/config lookups. Returns configKey as a
 * fallback when the provider or a representative model is unavailable.
 */
async function resolveProviderKey(
  providerId: string,
  configKey?: string,
): Promise<string | undefined> {
  const provider = models.getProvider(providerId);
  // Any model of the provider works — auth resolution only needs provider/baseUrl.
  const model = getBuiltinModels(providerId as never)[0] as Model<Api> | undefined;
  if (provider?.auth.apiKey && model) {
    try {
      const credential = configKey ? { type: "api_key" as const, key: configKey } : undefined;
      const res = await provider.auth.apiKey.resolve({ model, ctx: authContext, credential });
      if (res?.auth.apiKey) return res.auth.apiKey;
    } catch (err) {
      aiLog.debug(`api key resolution failed for ${providerId}`, log.errorData(err));
    }
  }
  return configKey;
}

/**
 * Optional hook fired whenever a provider's OAuth credentials are rotated and
 * persisted. The daemon registers this to fan the fresh token out to running
 * minds (see credential-sync.ts), making the daemon the single refresh
 * authority. Registered via setProviderRefreshHook to avoid an import cycle.
 */
type ProviderRefreshHook = (providerId: string) => void;
let providerRefreshHook: ProviderRefreshHook | undefined;

export function setProviderRefreshHook(hook: ProviderRefreshHook | undefined): void {
  providerRefreshHook = hook;
}

/** Fire the registered refresh hook, swallowing/logging any error. */
export function fireProviderRefreshHook(providerId: string): void {
  try {
    providerRefreshHook?.(providerId);
  } catch (err) {
    aiLog.warn(`provider refresh hook failed for ${providerId}`, log.errorData(err));
  }
}

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

/** Returns provider IDs that have credentials (config or ambient/env). */
export async function getConfiguredProviders(): Promise<string[]> {
  const ai = getAiConfig();
  const configured = new Set<string>();

  // Providers with explicit config
  if (ai) {
    for (const id of Object.keys(ai.providers)) {
      const p = ai.providers[id];
      if (p.apiKey || p.oauth) configured.add(id);
    }
  }

  // Providers with ambient/env credentials
  for (const id of getBuiltinProviders()) {
    if (!configured.has(id) && (await resolveProviderKey(id))) {
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
export async function resolveTemplate(modelId?: string): Promise<string> {
  if (!modelId) {
    // Check first enabled model's provider
    const enabled = getEnabledModels();
    if (enabled.length > 0) {
      const model = findModel(enabled[0]);
      if (model) return templateForProvider(model.provider);
    }
    // Check configured providers
    const providers = await getConfiguredProviders();
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
export async function getAvailableModels(): Promise<Model<Api>[]> {
  const providers = await getConfiguredProviders();
  const result: Model<Api>[] = [];
  for (const provider of providers) {
    result.push(...(getBuiltinModels(provider as never) as Model<Api>[]));
  }
  return result;
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
          // Fan the rotated token out to running minds (single refresh authority).
          fireProviderRefreshHook(providerId);
        }
        return result.apiKey;
      }
    } catch (err) {
      aiLog.warn(`OAuth key resolution failed for ${providerId}`, log.errorData(err));
    }
  }

  return resolveProviderKey(providerId, providerConfig?.apiKey);
}

/** Resolve a model ID to the full provider:model format needed by the pi template. */
export function qualifyModelId(modelId: string): string {
  if (modelId.includes(":")) return modelId;
  const model = findModel(modelId);
  if (model) return `${model.provider}:${model.id}`;
  return modelId;
}

/** Strip provider prefix from a qualified model ID (e.g. "openai-codex:gpt-5.4" → "gpt-5.4"). */
export function unqualifyModelId(modelId: string): string {
  const idx = modelId.indexOf(":");
  return idx >= 0 ? modelId.slice(idx + 1) : modelId;
}

function findModel(modelId: string): Model<Api> | undefined {
  // Exact match against the built-in catalog
  for (const provider of getBuiltinProviders()) {
    const model = getBuiltinModel(provider as never, modelId as never);
    if (model) return model as Model<Api>;
  }
  // Prefix match fallback
  for (const provider of getBuiltinProviders()) {
    const found = getBuiltinModels(provider as never).find((m) => m.id.startsWith(modelId));
    if (found) return found as Model<Api>;
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

    const response = await models.complete(
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
