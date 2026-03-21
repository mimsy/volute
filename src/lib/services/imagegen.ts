/**
 * Image generation service — multi-provider image generation.
 *
 * Manages provider config, model discovery, and generation.
 * Config lives in GlobalConfig.imagegen.
 */

import Replicate from "replicate";
import { type ImagegenConfig, readGlobalConfig, writeGlobalConfig } from "../setup.js";

// --- Provider registry ---

type ImagegenProviderDef = {
  envVar: string;
  generate: (model: string, prompt: string, apiKey: string) => Promise<Buffer>;
  search: (query: string, apiKey: string) => Promise<ModelSearchResult[]>;
};

const PROVIDERS: Record<string, ImagegenProviderDef> = {
  replicate: {
    envVar: "REPLICATE_API_TOKEN",
    generate: replicateGenerate,
    search: replicateSearch,
  },
  openrouter: {
    envVar: "OPENROUTER_API_KEY",
    generate: openrouterGenerate,
    search: openrouterSearch,
  },
};

// --- Replicate provider ---

async function replicateGenerate(model: string, prompt: string, apiKey: string): Promise<Buffer> {
  const replicate = new Replicate({ auth: apiKey });
  const output = await replicate.run(model as `${string}/${string}`, {
    input: { prompt },
  });

  const file = Array.isArray(output) ? output[0] : output;
  if (!file) throw new Error(`Model ${model} returned no output`);

  // Some models return a URL string instead of FileOutput
  if (typeof file === "string") {
    const res = await fetch(file);
    if (!res.ok) throw new Error(`Failed to fetch image from URL: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  // FileOutput implements ReadableStream — collect into Buffer
  const chunks: Uint8Array[] = [];
  for await (const chunk of file as AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function replicateSearch(query: string, apiKey: string): Promise<ModelSearchResult[]> {
  const replicate = new Replicate({ auth: apiKey });
  const response = await replicate.models.search(query || "text to image");
  return response.results.slice(0, 20).map((m) => ({
    id: `replicate:${m.owner}/${m.name}`,
    name: m.name,
    description: m.description?.slice(0, 200),
    owner: m.owner,
  }));
}

// --- OpenRouter provider ---

async function openrouterGenerate(model: string, prompt: string, apiKey: string): Promise<Buffer> {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      modalities: ["image", "text"],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => `HTTP ${res.status}`);
    throw new Error(`OpenRouter API error: ${body}`);
  }

  const data = (await res.json()) as {
    choices?: Array<{
      message?: { images?: Array<{ image_url?: { url?: string } }> };
    }>;
  };

  const imageUrl = data.choices?.[0]?.message?.images?.[0]?.image_url?.url;
  if (!imageUrl) throw new Error("OpenRouter returned no image");

  // Data URL: data:image/png;base64,...
  const match = imageUrl.match(/^data:[^;]+;base64,(.+)$/);
  if (match) {
    return Buffer.from(match[1], "base64");
  }

  // Regular URL — fetch it
  const imgRes = await fetch(imageUrl);
  if (!imgRes.ok) throw new Error(`Failed to fetch image from URL: ${imgRes.status}`);
  return Buffer.from(await imgRes.arrayBuffer());
}

async function openrouterSearch(query: string, _apiKey: string): Promise<ModelSearchResult[]> {
  const res = await fetch("https://openrouter.ai/api/v1/models?output_modalities=image");
  if (!res.ok) throw new Error(`OpenRouter model list failed: ${res.status}`);

  const data = (await res.json()) as {
    data?: Array<{ id: string; name: string; description?: string }>;
  };

  const models = data.data ?? [];
  const q = query.toLowerCase();
  const filtered = models
    .filter((m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q))
    .slice(0, 20);

  return filtered.map((m) => {
    const parts = m.id.split("/");
    return {
      id: `openrouter:${m.id}`,
      name: m.name,
      description: m.description?.slice(0, 200),
      owner: parts[0] || m.id,
    };
  });
}

// --- Model ID parsing ---

export function parseModelId(prefixedId: string): { provider: string; model: string } {
  const colonIdx = prefixedId.indexOf(":");
  if (colonIdx === -1)
    throw new Error(
      `Model ID must be provider-prefixed (e.g. replicate:owner/model), got: ${prefixedId}`,
    );
  const provider = prefixedId.slice(0, colonIdx);
  const model = prefixedId.slice(colonIdx + 1);
  if (!PROVIDERS[provider]) throw new Error(`Unknown imagegen provider: ${provider}`);
  return { provider, model };
}

// --- Config CRUD ---

export function getImagegenConfig(): ImagegenConfig | null {
  return readGlobalConfig().imagegen ?? null;
}

function updateImagegenConfig(fn: (ig: ImagegenConfig) => void): void {
  const config = readGlobalConfig();
  const ig: ImagegenConfig = config.imagegen ?? {};
  fn(ig);
  config.imagegen = ig;
  writeGlobalConfig(config);
}

export function saveProviderConfig(id: string, apiKey: string): void {
  if (!PROVIDERS[id]) throw new Error(`Unknown imagegen provider: ${id}`);
  updateImagegenConfig((ig) => {
    ig.providers = ig.providers ?? {};
    ig.providers[id] = { apiKey };
  });
}

export function removeProviderConfig(id: string): void {
  if (!PROVIDERS[id]) throw new Error(`Unknown imagegen provider: ${id}`);
  updateImagegenConfig((ig) => {
    if (ig.providers) {
      delete ig.providers[id];
      if (Object.keys(ig.providers).length === 0) delete ig.providers;
    }
  });
}

export type ConfiguredProvider = {
  id: string;
  configured: boolean;
  authMethod: "api_key" | "env_var" | null;
};

export function getConfiguredProviders(): ConfiguredProvider[] {
  const config = readGlobalConfig();
  const ig = config.imagegen ?? null;
  const aiProviders = config.ai?.providers;
  return Object.entries(PROVIDERS).map(([id, { envVar }]) => {
    const providerConfig = ig?.providers?.[id];
    if (providerConfig?.apiKey) return { id, configured: true, authMethod: "api_key" as const };
    // Check AI provider config fallback
    if (aiProviders?.[id]?.apiKey) return { id, configured: true, authMethod: "api_key" as const };
    if (process.env[envVar]) return { id, configured: true, authMethod: "env_var" as const };
    return { id, configured: false, authMethod: null };
  });
}

export function resolveApiKey(providerId: string): string | undefined {
  const provider = PROVIDERS[providerId];
  if (!provider) return undefined;
  const config = readGlobalConfig();
  // 1. Imagegen-specific config key
  const configKey = config.imagegen?.providers?.[providerId]?.apiKey;
  if (configKey) return configKey;
  // 2. AI provider config key (e.g., OpenRouter configured for chat)
  const aiKey = config.ai?.providers?.[providerId]?.apiKey;
  if (aiKey) return aiKey;
  // 3. Env var fallback
  return process.env[provider.envVar] || undefined;
}

// --- Model discovery ---

export function getEnabledModels(): string[] {
  return getImagegenConfig()?.models ?? [];
}

export function setEnabledModels(ids: string[]): void {
  updateImagegenConfig((ig) => {
    ig.models = ids;
  });
}

export type ModelSearchResult = {
  id: string;
  name: string;
  description?: string;
  owner: string;
};

export async function searchModels(
  query?: string,
  provider?: string,
): Promise<ModelSearchResult[]> {
  if (provider) {
    const providerDef = PROVIDERS[provider];
    if (!providerDef) throw new Error(`Unknown imagegen provider: ${provider}`);
    const apiKey = resolveApiKey(provider);
    if (!apiKey) throw new Error(`No ${provider} API key configured`);
    return providerDef.search(query || "text to image", apiKey);
  }

  // Search all configured providers in parallel
  const searches: Promise<ModelSearchResult[]>[] = [];
  for (const [id, def] of Object.entries(PROVIDERS)) {
    const apiKey = resolveApiKey(id);
    if (!apiKey) continue;
    searches.push(def.search(query || "text to image", apiKey).catch(() => []));
  }
  if (searches.length === 0) {
    throw new Error("No imagegen providers configured");
  }
  return (await Promise.all(searches)).flat();
}

// --- Generation ---

export async function generateImage(model: string, prompt: string): Promise<Buffer> {
  const { provider: providerId, model: modelId } = parseModelId(model);
  const apiKey = resolveApiKey(providerId);
  if (!apiKey) throw new Error(`No ${providerId} API key configured`);
  return PROVIDERS[providerId].generate(modelId, prompt, apiKey);
}
