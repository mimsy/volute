import { promptLine } from "./prompt.js";

type ModelInfo = {
  id: string;
  name: string;
  provider: string;
  contextWindow?: number;
  enabled: boolean;
};

type DaemonFetch = (path: string, options?: RequestInit) => Promise<Response>;

/**
 * Interactive picker over the models an admin has enabled. Returns a qualified
 * `provider:id`, or undefined when no model is enabled at all (the caller decides
 * whether that is fatal).
 *
 * Only call this with someone at a terminal. `promptLine` resolves on a newline byte
 * and has no end-of-stream handler, so on a closed stdin it waits forever.
 */
export async function chooseModel(daemonFetch: DaemonFetch): Promise<string | undefined> {
  const res = await daemonFetch("/api/v1/system/ai/models");
  if (!res.ok) {
    // The route is admin-only, so the likely failure is authorization, not a dead
    // daemon — every other request the caller just made reached it. In practice only
    // 403 arrives: daemonFetch intercepts a 401 on this path with its own "run volute
    // login" and exits. 401 is handled anyway, for a caller that passes its own fetch.
    const hint =
      res.status === 401 || res.status === 403
        ? "Listing models requires an admin account."
        : "Is the daemon running?";
    console.error(`Failed to fetch AI models (HTTP ${res.status}). ${hint}`);
    process.exit(1);
  }

  const models = (await res.json()) as ModelInfo[];
  const enabled = models.filter((m) => m.enabled);
  if (enabled.length === 0) return undefined;

  console.log("\nAvailable models:");
  for (let i = 0; i < enabled.length; i++) {
    console.log(`  ${i + 1}) ${enabled[i].name} (${enabled[i].provider})`);
  }

  const answer = await promptLine(`\nChoose a model [1-${enabled.length}]: `);
  const idx = parseInt(answer, 10) - 1;
  if (Number.isNaN(idx) || idx < 0 || idx >= enabled.length) {
    console.error("Invalid selection");
    process.exit(1);
  }

  const chosen = enabled[idx];
  return `${chosen.provider}:${chosen.id}`;
}

export type ResolvedModel = {
  /** Sent as `model` on the create request. Undefined leaves the choice to the daemon. */
  send?: string;
  /** What the mind will run on, in words, so the caller can say it out loud. */
  describe: string;
  /** True when nothing upstream decided. A caller with a human present may ask. */
  mayAsk: boolean;
};

/**
 * Decide which model a mind is born on, without asking anyone.
 *
 * Sending no model is a real answer, not a failure: the daemon applies
 * `mindDefaults.cognition.model` when the request carries none, and past that the
 * template's own config stands. So this only speaks when it knows something the
 * daemon doesn't, and it never blocks — a caller here may be a script, a cron
 * schedule, or a mind, and none of those can answer a question.
 *
 * The spirit's model is the one genuine inference, and it is only sound when the
 * spirit runs on this template's provider. Handing a codex mind the spirit's
 * `claude-opus-5` writes a model its runtime cannot call into config.json, and the
 * mind comes up mute — worse than the template default it displaced.
 */
export async function resolveModel(
  template: string,
  explicit: string | undefined,
): Promise<ResolvedModel> {
  if (explicit) return { send: explicit, describe: explicit, mayAsk: false };

  // An admin's configured default is already an answer, and it applies on every
  // template. Speaking over it would make the Mind Defaults setting unreachable.
  const { readGlobalConfig } = await import("@volute/daemon/lib/config/setup.js");
  const adminDefault = readGlobalConfig().mindDefaults?.cognition?.model;
  if (adminDefault) {
    return { describe: `${adminDefault} (system default)`, mayAsk: false };
  }

  // The claude template is left alone, as it always has been. Note this is *not*
  // because it has nothing hardcoded — `_base/home/.config/config.json` pins a model
  // and templates/claude/ ships no override — so a claude mind does inherit a model
  // nobody chose. Borrowing the spirit's model here would change how every default
  // `mind create` and claude seed is born, which is a bigger call than this change.
  if (template === "claude") {
    return { describe: "the claude template's default", mayAsk: false };
  }

  const { getSpiritModel } = await import("@volute/daemon/lib/mind/spirit.js");
  const { qualifyModelId, resolveTemplate } = await import("@volute/daemon/lib/ai-service.js");
  // Empty for a sandboxed mind — the sandbox denies it the daemon's whole $HOME — which
  // is fine: the answer then falls to the daemon, which can read its own config.
  const spiritModel = getSpiritModel();
  if (spiritModel && (await resolveTemplate(spiritModel)) === template) {
    const model = template === "pi" ? qualifyModelId(spiritModel) : spiritModel;
    return { send: model, describe: `${model} (the spirit's model)`, mayAsk: false };
  }

  return { describe: `the ${template} template's default`, mayAsk: true };
}
