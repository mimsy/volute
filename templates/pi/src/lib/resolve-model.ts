import { getBuiltinModel, getBuiltinModels } from "@earendil-works/pi-ai/providers/all";

/** Length of the shared leading prefix of two strings. */
function sharedPrefixLength(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

/**
 * Build a usable model for a custom id not in the built-in catalog by cloning a
 * sibling built-in model of the same provider (inherits api/baseUrl/compat/caps and
 * its rates, so the custom model is priced approximately rather than not at all) and
 * overriding id/name. Picks the sibling sharing the longest id prefix (same family),
 * breaking ties toward the largest context window. Returns undefined when the
 * provider has no built-in models at all.
 *
 * NOTE: mirrors pickSibling/buildCustomModel in the daemon's
 * packages/daemon/src/lib/ai-service.ts (kept as a copy since the template can't
 * import daemon code); keep the two in sync.
 */
function buildCustomModel(provider: string, id: string) {
  const siblings = getBuiltinModels(provider as any);
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
  return { ...best, id, name: id };
}

/**
 * The custom models the host registered, as `provider:id`, from the daemon-set
 * `VOLUTE_CUSTOM_MODELS`. Empty when unset or unreadable: nothing beyond the catalog runs.
 */
export function registeredCustomModels(raw = process.env.VOLUTE_CUSTOM_MODELS): string[] {
  try {
    const parsed: unknown = JSON.parse(raw ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((m): m is string => typeof m === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Resolve a `provider:id` model string: the catalog entry when there is one, a clone of
 * a sibling for a custom model the host registered, and otherwise a refusal. A model
 * with no known price would run unmetered, outside the spend cap, so an id that is
 * neither is not run on a guess. The daemon refuses the same ids before spawning (and
 * says so to the mind and host); this is the backstop for a start it didn't check.
 */
export function resolveModel(modelStr: string, customModels: readonly string[] = []) {
  const [provider, ...rest] = modelStr.split(":");
  const modelId = rest.join(":");

  // Exact catalog match wins.
  const exact = getBuiltinModel(provider as any, modelId as any);
  if (exact) return exact;

  // A registered custom id is authoritative: clone a sibling of the same provider. The
  // daemon only ever writes exact ids here, so we deliberately do NOT prefix-match — doing
  // so could silently resolve a selected custom id (e.g. "gpt-5") to a different catalog
  // model that starts with it (e.g. "gpt-5-codex"). Mirrors the daemon's exact→custom
  // ordering in ai-service.ts findModel().
  if (customModels.includes(`${provider}:${modelId}`)) {
    const custom = buildCustomModel(provider, modelId);
    if (custom) return custom;
    throw new Error(`Model not found: ${modelStr}\nUnknown provider: ${provider}`);
  }

  throw new Error(
    `Your model, "${modelStr}", is neither in Volute's model catalog nor registered on this ` +
      `system as a custom model, so it can't be run: its turns would have no price and never ` +
      `count against your spend cap. Set "model" in home/.config/config.json to one that ` +
      `resolves (\`volute config models\` lists the models enabled here), or ask the host to ` +
      `register it as a custom model in Settings → AI.`,
  );
}
