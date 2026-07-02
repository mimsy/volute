import { getBuiltinModel, getBuiltinModels } from "@earendil-works/pi-ai/providers/all";

/** Length of the shared leading prefix of two strings. */
function sharedPrefixLength(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

/**
 * Build a usable model for a custom id not in the built-in catalog by cloning a
 * sibling built-in model of the same provider (inherits api/baseUrl/compat/caps)
 * and overriding id/name. Picks the sibling sharing the longest id prefix (same
 * family), breaking ties toward the largest context window. Returns undefined
 * when the provider has no built-in models at all.
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
  return { ...best, id, name: id, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
}

export function resolveModel(modelStr: string) {
  const [provider, ...rest] = modelStr.split(":");
  const modelId = rest.join(":");

  // Exact catalog match wins.
  const exact = getBuiltinModel(provider as any, modelId as any);
  if (exact) return exact;

  // Not in the catalog: treat the id as authoritative and clone a sibling of the
  // same provider. The daemon only ever writes exact ids here (built-in or an
  // admin-registered custom id), so we deliberately do NOT prefix-match — doing so
  // could silently resolve a selected custom id (e.g. "gpt-5") to a different
  // catalog model that starts with it (e.g. "gpt-5-codex"). Mirrors the daemon's
  // exact→custom ordering in ai-service.ts findModel().
  const custom = buildCustomModel(provider, modelId);
  if (custom) {
    console.warn(
      `[resolve-model] "${modelStr}" is not in the built-in catalog; cloning provider defaults from a sibling model. If this id is a typo it will fail at request time.`,
    );
    return custom;
  }

  throw new Error(`Model not found: ${modelStr}\nUnknown provider: ${provider}`);
}
