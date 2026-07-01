import { getBuiltinModel, getBuiltinModels } from "@earendil-works/pi-ai/providers/all";

export function resolveModel(modelStr: string) {
  const [provider, ...rest] = modelStr.split(":");
  const modelId = rest.join(":");

  // Try exact match first, then prefix match against available models
  let model = getBuiltinModel(provider as any, modelId as any);
  if (!model) {
    const available = getBuiltinModels(provider as any);
    const found = available.find((m) => m.id.startsWith(modelId));
    if (found) model = found;
  }
  if (!model) {
    const available = getBuiltinModels(provider as any);
    throw new Error(
      `Model not found: ${modelStr}\nAvailable ${provider} models: ${available.map((m) => m.id).join(", ")}`,
    );
  }
  return model;
}
