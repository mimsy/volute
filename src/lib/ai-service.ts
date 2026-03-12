import { complete, getModel, getModels, getOAuthApiKey } from "@mariozechner/pi-ai";
import log from "./logger.js";
import { type AiConfig, readGlobalConfig, writeGlobalConfig } from "./setup.js";

export type { AiConfig } from "./setup.js";

const aiLog = log.child("ai-service");

export function getAiConfig(): AiConfig | null {
  const config = readGlobalConfig();
  return config.ai ?? null;
}

export function isAiConfigured(): boolean {
  return getAiConfig() != null;
}

export function saveAiConfig(ai: AiConfig): void {
  const config = readGlobalConfig();
  writeGlobalConfig({ ...config, ai });
}

export function removeAiConfig(): void {
  const config = readGlobalConfig();
  delete config.ai;
  writeGlobalConfig(config);
}

function resolveModel(provider: string, modelId: string) {
  let model = getModel(provider as any, modelId as any);
  if (!model) {
    const available = getModels(provider as any);
    const found = available.find((m) => m.id.startsWith(modelId));
    if (found) model = found;
  }
  return model;
}

export async function aiComplete(
  systemPrompt: string,
  userMessage: string,
): Promise<string | null> {
  const config = getAiConfig();
  if (!config) return null;

  const model = resolveModel(config.provider, config.model);
  if (!model) {
    aiLog.warn(`model not found: ${config.provider}:${config.model}`);
    return null;
  }

  try {
    let apiKey: string | undefined;

    if (config.oauth) {
      const result = await getOAuthApiKey(config.provider, {
        [config.provider]: config.oauth,
      });
      if (result) {
        apiKey = result.apiKey;
        // Persist refreshed credentials
        if (result.newCredentials.access !== config.oauth.access) {
          saveAiConfig({ ...config, oauth: result.newCredentials });
        }
      }
    } else if (config.apiKey) {
      apiKey = config.apiKey;
    }

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
