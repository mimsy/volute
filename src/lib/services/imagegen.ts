/**
 * Image generation service — Replicate-based image generation.
 *
 * Manages provider config, model discovery, and generation.
 * Config lives in GlobalConfig.imagegen.
 */

import Replicate from "replicate";
import { type ImagegenConfig, readGlobalConfig, writeGlobalConfig } from "../setup.js";

// --- Provider registry ---

const PROVIDERS: Record<string, { envVar: string }> = {
  replicate: { envVar: "REPLICATE_API_TOKEN" },
};

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
  const ig = getImagegenConfig();
  return Object.entries(PROVIDERS).map(([id, { envVar }]) => {
    const providerConfig = ig?.providers?.[id];
    if (providerConfig?.apiKey) return { id, configured: true, authMethod: "api_key" as const };
    if (process.env[envVar]) return { id, configured: true, authMethod: "env_var" as const };
    return { id, configured: false, authMethod: null };
  });
}

export function resolveApiKey(providerId: string): string | undefined {
  const provider = PROVIDERS[providerId];
  if (!provider) return undefined;
  const ig = getImagegenConfig();
  const configKey = ig?.providers?.[providerId]?.apiKey;
  if (configKey) return configKey;
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

export async function searchModels(query?: string): Promise<ModelSearchResult[]> {
  const apiKey = resolveApiKey("replicate");
  if (!apiKey) throw new Error("No Replicate API key configured");

  const replicate = new Replicate({ auth: apiKey });
  const response = await replicate.models.search(query || "text to image");
  return response.results.slice(0, 20).map((m) => ({
    id: `${m.owner}/${m.name}`,
    name: m.name,
    description: m.description?.slice(0, 200),
    owner: m.owner,
  }));
}

// --- Generation ---

export async function generateImage(model: string, prompt: string): Promise<Buffer> {
  const apiKey = resolveApiKey("replicate");
  if (!apiKey) throw new Error("No Replicate API key configured");

  const replicate = new Replicate({ auth: apiKey });
  const output = await replicate.run(model as `${string}/${string}`, {
    input: { prompt },
  });

  const file = Array.isArray(output) ? output[0] : output;
  if (!file) throw new Error(`Model ${model} returned no output`);

  // FileOutput implements ReadableStream — collect into Buffer
  const chunks: Uint8Array[] = [];
  for await (const chunk of file as AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
