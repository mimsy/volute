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
  type CustomModel,
  readGlobalConfig,
  writeGlobalConfig,
} from "./config/setup.js";
import log from "./util/logger.js";

export type { AiConfig, AiProviderConfig, CustomModel } from "./config/setup.js";

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

/** Env var each provider's key is injected under (mirrors mind-manager injection). */
const PROVIDER_ENV_VAR: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  "openai-codex": "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GEMINI_API_KEY",
  groq: "GROQ_API_KEY",
  cerebras: "CEREBRAS_API_KEY",
  xai: "XAI_API_KEY",
  mistral: "MISTRAL_API_KEY",
  zai: "ZAI_API_KEY",
};

/**
 * The provider whose credentials a mind of this template needs at spawn. Mirrors
 * the credential injection in `MindManager.startMind`: claude → anthropic, codex →
 * openai-codex, pi → the provider prefix of its `provider:model` id. Returns
 * undefined when the provider can't be determined (a pi mind whose model we don't
 * have) — callers treat that as "can't verify, don't warn".
 */
export function providerForMindTemplate(
  template: string | undefined,
  model?: string,
): string | undefined {
  if (!template || template === "claude") return "anthropic";
  if (template === "codex") return "openai-codex";
  if (model?.includes(":")) return model.split(":")[0];
  return undefined;
}

/**
 * If a mind of this template/model would spawn without usable model credentials,
 * return an operator-actionable warning explaining it will stay silent and how to
 * fix it; otherwise null. Checks the same sources the daemon injects at spawn
 * (OAuth, stored key, ambient env), so it reflects what the mind will actually get.
 * Non-blocking by design: creation still proceeds, the mind just can't reply yet.
 */
export async function missingCredentialWarning(
  template: string | undefined,
  model: string | undefined,
  mindName: string,
): Promise<string | null> {
  const provider = providerForMindTemplate(template, model);
  if (!provider) return null; // provider undeterminable — don't warn on the unverifiable
  if (await resolveApiKey(provider)) return null;
  // Codex also honors an ambient OPENAI_API_KEY that resolveApiKey may not surface.
  if (provider === "openai-codex" && process.env.OPENAI_API_KEY) return null;
  const envVar =
    PROVIDER_ENV_VAR[provider] ?? `${provider.toUpperCase().replace(/-/g, "_")}_API_KEY`;
  return (
    `No ${provider} credentials are configured, so ${mindName} will start but stay silent ` +
    `until a key is available. Set one with \`volute env set ${envVar} <key> --mind ${mindName}\`, ` +
    `or configure the ${provider} provider in the web dashboard (Settings → Providers).`
  );
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

/**
 * One-time migration: convert bare model ids in `ai.models`, `spiritModel`, and
 * `ai.utilityModel` to provider-qualified `provider:model` form. A bare id is
 * ambiguous (many providers serve the same id), so this pins each to the
 * explicitly-configured provider(s) that serve it: the enabled list expands to
 * one entry per configured provider, and the single-value defaults qualify to
 * the first configured provider that serves them. Idempotent — a no-op once
 * every stored id already contains a ":".
 */
export function migrateAiModelQualification(): void {
  const config = readGlobalConfig();
  const ai = config.ai;
  const isBare = (id?: string): id is string => id != null && !id.includes(":");

  const hasBareInList = (ai?.models ?? []).some(isBare);
  if (!hasBareInList && !isBare(config.spiritModel) && !isBare(ai?.utilityModel)) return;

  // Only providers the admin explicitly added (with credentials) — not ambient
  // env/OAuth providers — are candidates, matching what the user configured.
  const providers = ai ? Object.keys(ai.providers) : [];
  const customModels = ai?.customModels ?? [];
  const providersServing = (bareId: string): string[] =>
    providers.filter(
      (p) =>
        getBuiltinModel(p as never, bareId as never) != null ||
        customModels.some((cm) => cm.provider === p && cm.id === bareId),
    );

  let changed = false;

  if (ai?.models) {
    const expanded: string[] = [];
    for (const id of ai.models) {
      if (!isBare(id)) {
        expanded.push(id);
        continue;
      }
      changed = true;
      for (const p of providersServing(id)) expanded.push(`${p}:${id}`);
    }
    ai.models = expanded.length > 0 ? [...new Set(expanded)] : undefined;
    if (!ai.models) delete ai.models;
  }

  const qualifyOne = (id: string | undefined): string | undefined => {
    if (!isBare(id)) return id;
    const [provider] = providersServing(id);
    if (!provider) return id; // no configured provider serves it — leave as-is
    changed = true;
    return `${provider}:${id}`;
  };
  config.spiritModel = qualifyOne(config.spiritModel);
  if (ai) ai.utilityModel = qualifyOne(ai.utilityModel);

  if (changed) writeGlobalConfig(config);
}

/** Get the admin-defined custom models (not in pi-ai's built-in catalog). */
export function getCustomModels(): CustomModel[] {
  return getAiConfig()?.customModels ?? [];
}

/** Register a custom model for a provider (no-op if it already exists). */
export function addCustomModel(provider: string, id: string, name?: string): void {
  const ai = getAiConfig() ?? { providers: {} };
  const customModels = ai.customModels ?? [];
  if (!customModels.some((m) => m.provider === provider && m.id === id)) {
    customModels.push({ provider, id, ...(name ? { name } : {}) });
  }
  ai.customModels = customModels;
  const config = readGlobalConfig();
  writeGlobalConfig({ ...config, ai });
}

/** Remove a custom model and drop it from the enabled list. */
export function removeCustomModel(provider: string, id: string): void {
  const ai = getAiConfig();
  if (!ai) return;
  const customModels = (ai.customModels ?? []).filter(
    (m) => !(m.provider === provider && m.id === id),
  );
  ai.customModels = customModels.length > 0 ? customModels : undefined;
  if (!ai.customModels) delete ai.customModels;
  if (ai.models) {
    // Enabled ids are provider-qualified ("provider:model").
    const qualified = `${provider}:${id}`;
    ai.models = ai.models.filter((mid) => mid !== qualified);
    if (ai.models.length === 0) delete ai.models;
  }
  const config = readGlobalConfig();
  writeGlobalConfig({ ...config, ai });
}

/** Length of the shared leading prefix of two strings. */
function sharedPrefixLength(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

/**
 * Pick the built-in model of `provider` that best represents a custom model
 * `id`: the sibling sharing the longest id prefix (assumed same family, so
 * likely matching api/compat/caps), breaking ties toward the largest context
 * window. When no family overlaps, this selects the largest-context sibling.
 * Returns undefined when the provider has no built-in models.
 *
 * NOTE: the pi template has its own copy of this heuristic in
 * templates/pi/src/lib/resolve-model.ts (the template can't import daemon code);
 * keep the two in sync.
 */
function pickSibling(provider: string, id: string): Model<Api> | undefined {
  const siblings = getBuiltinModels(provider as never) as Model<Api>[];
  if (siblings.length === 0) return undefined;
  let best = siblings[0];
  let bestPrefix = -1;
  for (const s of siblings) {
    const prefix = sharedPrefixLength(s.id, id);
    if (prefix > bestPrefix || (prefix === bestPrefix && s.contextWindow > best.contextWindow)) {
      bestPrefix = prefix;
      best = s;
    }
  }
  return best;
}

/**
 * Build a usable Model for a custom id by cloning a sibling built-in model of
 * the same provider (inherits api/baseUrl/compat/caps) and overriding id/name.
 * Cost is zeroed since we don't know the real pricing. Returns undefined when
 * the provider has no built-in template.
 */
export function buildCustomModel(
  provider: string,
  id: string,
  name?: string,
): Model<Api> | undefined {
  const sibling = pickSibling(provider, id);
  if (!sibling) return undefined;
  return {
    ...sibling,
    id,
    name: name ?? id,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

/**
 * Drop any custom models that pi-ai has since added to its built-in catalog
 * (built-in always wins). Writes only when something is pruned. Returns the
 * remaining custom models.
 */
function pruneAbsorbedCustomModels(): CustomModel[] {
  const ai = getAiConfig();
  const custom = ai?.customModels ?? [];
  if (custom.length === 0 || !ai) return custom;
  const kept = custom.filter((cm) => !getBuiltinModel(cm.provider as never, cm.id as never));
  if (kept.length !== custom.length) {
    ai.customModels = kept.length > 0 ? kept : undefined;
    if (!ai.customModels) delete ai.customModels;
    const config = readGlobalConfig();
    writeGlobalConfig({ ...config, ai });
  }
  return kept;
}

/** Returns all models from configured providers, including custom models. */
export async function getAvailableModels(): Promise<Model<Api>[]> {
  const providers = await getConfiguredProviders();
  const configured = new Set(providers);
  const result: Model<Api>[] = [];
  const seen = new Set<string>();
  for (const provider of providers) {
    for (const m of getBuiltinModels(provider as never) as Model<Api>[]) {
      result.push(m);
      seen.add(m.id);
    }
  }
  // Custom models for configured providers, skipping ids the catalog now covers.
  for (const cm of pruneAbsorbedCustomModels()) {
    if (!configured.has(cm.provider) || seen.has(cm.id)) continue;
    const built = buildCustomModel(cm.provider, cm.id, cm.name);
    if (built) {
      result.push(built);
      seen.add(cm.id);
    } else {
      aiLog.warn(`custom model ${cm.provider}:${cm.id} has no sibling to clone from; skipping`);
    }
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

export function findModel(modelId: string): Model<Api> | undefined {
  // Provider-qualified id ("provider:model") resolves within that provider only,
  // so the same bare id under different providers stays unambiguous.
  const colon = modelId.indexOf(":");
  if (colon >= 0) {
    const provider = modelId.slice(0, colon);
    const bareId = modelId.slice(colon + 1);
    const built = getBuiltinModel(provider as never, bareId as never);
    if (built) return built as Model<Api>;
    for (const cm of getCustomModels()) {
      if (cm.provider === provider && cm.id === bareId) {
        const model = buildCustomModel(cm.provider, cm.id, cm.name);
        if (model) return model;
      }
    }
    return undefined;
  }
  // Bare id (legacy / fallback): exact built-in match against the catalog
  // (built-in always wins).
  for (const provider of getBuiltinProviders()) {
    const model = getBuiltinModel(provider as never, modelId as never);
    if (model) return model as Model<Api>;
  }
  // Admin-defined custom models
  for (const cm of getCustomModels()) {
    if (cm.id === modelId) {
      const built = buildCustomModel(cm.provider, cm.id, cm.name);
      if (built) return built;
    }
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
