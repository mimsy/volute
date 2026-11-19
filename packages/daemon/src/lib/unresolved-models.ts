import { resolve } from "node:path";
import { findModel, getEnabledModels } from "./ai-service.js";
import { alertHost } from "./chat/system-events.js";
import { getSpiritName } from "./config/setup.js";
import { voluteSystemDir } from "./mind/registry.js";
import { loadJsonMap, saveJsonMap } from "./util/json-state.js";
import log from "./util/logger.js";

const ulog = log.child("unresolved-models");

/** The alert kind {@link alertHost} fans out for enabled model ids that no longer resolve. */
export const UNRESOLVED_MODELS_ALERT_KIND = "enabled_models_unresolved";

/** Which unresolved ids have already been alerted about, and when (epoch millis). */
function statePath(): string {
  return resolve(voluteSystemDir(), "unresolved-models.json");
}

/**
 * Enabled model ids (`ai.models`) that resolve to neither a catalog model nor a
 * registered custom model.
 *
 * The catalog is pi-ai's, and a pi-ai upgrade can drop ids from it (1.x dropped
 * gpt-5.5 from openai-codex and github-copilot, among ~190 others). Such an id stays in
 * the enabled list, but everything that reads the list skips it silently: Settings
 * builds its list from the models that resolve, so the entry is not even shown there.
 */
export function findUnresolvedEnabledModels(): string[] {
  return getEnabledModels().filter((id) => !findModel(id));
}

export function unresolvedModelsMessage(ids: string[]): string {
  const list = ids.map((id) => `- ${id}`).join("\n");
  return (
    `These models are enabled in this system's AI settings, but Volute's model catalog no ` +
    `longer carries them, so nothing can use them: they are skipped when a model is ` +
    `picked, and they no longer appear in the dashboard's model list.\n\n${list}\n\n` +
    `Nothing has been changed. The next time the enabled models are saved from ` +
    `Settings → AI, these entries drop out of the list. If a provider still serves one of ` +
    `them, it can be added back in Settings as a custom model by its exact id — but a ` +
    `custom model has no catalog rates, so its turns are recorded without a cost.`
  );
}

/**
 * Warn, at daemon start, about enabled model ids that no longer resolve.
 *
 * Boot is the useful cadence: the catalog only changes when Volute is upgraded, which
 * restarts the daemon. The log line is written on every start for a host reading the
 * journal; `alertHost` reaches the host who never does, through the spirit (which can
 * relay it) and the dashboard. It goes to the spirit because the enabled list is the
 * system's, not any one mind's.
 *
 * Each id is alerted once, recorded in a state file — the spirit's copy is an
 * `immediate` event, so an unrecorded alert would run a spirit turn on every restart.
 * All new ids go out in one alert. An id that resolves again is forgotten, so it is
 * reported afresh if it is ever dropped again.
 */
export async function reportUnresolvedEnabledModels(): Promise<void> {
  const unresolved = findUnresolvedEnabledModels();
  const alerted = loadJsonMap(statePath());
  let changed = false;

  for (const id of alerted.keys()) {
    if (!unresolved.includes(id)) {
      alerted.delete(id);
      changed = true;
    }
  }

  if (unresolved.length > 0) {
    ulog.warn(
      `enabled models no longer in the model catalog, so nothing can use them: ` +
        `${unresolved.join(", ")}. Saving the enabled models from Settings → AI drops them.`,
      { ids: unresolved },
    );
    const fresh = unresolved.filter((id) => !alerted.has(id));
    if (fresh.length > 0) {
      await alertHost(
        getSpiritName(),
        UNRESOLVED_MODELS_ALERT_KIND,
        unresolvedModelsMessage(fresh),
      );
      for (const id of fresh) alerted.set(id, Date.now());
      changed = true;
    }
  }

  if (changed) saveJsonMap(statePath(), alerted);
}
