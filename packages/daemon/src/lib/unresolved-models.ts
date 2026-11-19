import { resolve } from "node:path";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { findModel, getCustomModels, getEnabledModels } from "./ai-service.js";
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

/** pi-ai 1.0.3 renamed this provider to `azure`; ids and credentials under it no longer resolve. */
const RENAMED_AZURE_PROVIDER = "azure-openai-responses";

/** What a host with ids under the provider pi-ai renamed has to do. Empty when none apply. */
function azureRenameNote(ids: string[]): string {
  if (!ids.some((id) => id.startsWith(`${RENAMED_AZURE_PROVIDER}:`))) return "";
  return (
    `\n\nThe ${RENAMED_AZURE_PROVIDER} provider was renamed \`azure\` (the model library ` +
    `Volute uses changed its name, so ids and credentials under the old name no longer ` +
    `resolve). Nothing was carried over: re-add the Azure credentials under \`azure\` in ` +
    `Settings → AI, then enable the models again from there, as \`azure:<model>\`.`
  );
}

export function unresolvedModelsMessage(ids: string[]): string {
  const list = ids.map((id) => `- ${id}`).join("\n");
  return (
    `These models are enabled in this system's AI settings, but Volute's model catalog no ` +
    `longer carries them, so nothing can use them: they are skipped when a model is ` +
    `picked, and they no longer appear in the dashboard's model list.\n\n${list}\n\n` +
    `Nothing has been changed. The next time the enabled models are saved from ` +
    `Settings → AI, these entries drop out of the list. If a provider still serves one of ` +
    `them, it can be added back in Settings as a custom model by its exact id; it is then ` +
    `priced at the rates of the catalog model closest to it, an approximation.` +
    azureRenameNote(ids)
  );
}

/**
 * Whether a pi mind's `provider:id` model names something it can run on: a catalog model,
 * or one the host registered as custom. Mirrors the pi template's `resolveModel`, which
 * refuses anything else — a model with no known price would run outside the spend cap.
 */
export function piModelResolves(model: string): boolean {
  const colon = model.indexOf(":");
  if (colon <= 0) return false;
  const provider = model.slice(0, colon);
  const id = model.slice(colon + 1);
  if (getBuiltinModel(provider as never, id as never)) return true;
  return getCustomModels().some((c) => c.provider === provider && c.id === id);
}

/** The alert kind for a pi mind refused a start because its model resolves to nothing. */
export const MIND_MODEL_UNRESOLVED_ALERT_KIND = "mind_model_unresolved";

/** What a refused pi mind is told — addressed to the mind, who lives with the choice. */
export function mindModelUnresolvedMessage(model: string): string {
  return (
    `You were not started, because your model, \`${model}\`, is neither in Volute's model ` +
    `catalog nor registered on this system as a custom model. Running it would leave your ` +
    `turns without a price, so they would never count against your spend cap.\n\n` +
    `To start again, your \`model\` in home/.config/config.json needs to name one that ` +
    `resolves: the host can pick one in the dashboard (your Settings → Model), and ` +
    `\`volute config models\` lists the models enabled here. Or, if the provider still ` +
    `serves \`${model}\`, the host can register it as a custom model in Settings → AI; it is ` +
    `then priced at the rates of the catalog model closest to it.` +
    azureRenameNote([model])
  );
}

/** Minds already alerted this daemon run, keyed `mind\0model`, so a retry doesn't repeat it. */
const refusedThisRun = new Set<string>();

/** Thrown by {@link refuseUnresolvedPiModel}; its message is for whoever asked for the start. */
export class UnresolvedMindModelError extends Error {}

/**
 * Refuse to start a pi mind whose configured model resolves to nothing, before it is spawned.
 *
 * The template refuses too, but only by dying at startup, which crash recovery reads as a
 * crash loop and nobody hears why. Checking here lets the refusal be said: once per mind and
 * model per daemon run, through `alertHost` — to the mind (queued until it runs again), the
 * spirit (who can relay it to the host) and the dashboard.
 */
export async function refuseUnresolvedPiModel(mind: string, model: string): Promise<void> {
  if (piModelResolves(model)) return;
  const refusal =
    `Not starting ${mind}: its model "${model}" is neither in the model catalog nor a ` +
    `registered custom model, so its turns would go unpriced. Set its model in the mind's ` +
    `Settings → Model, or register the id as a custom model in Settings → AI.`;
  ulog.warn(refusal, { mind, model });
  const key = `${mind}\0${model}`;
  if (!refusedThisRun.has(key)) {
    refusedThisRun.add(key);
    await alertHost(mind, MIND_MODEL_UNRESOLVED_ALERT_KIND, mindModelUnresolvedMessage(model));
  }
  throw new UnresolvedMindModelError(refusal);
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
