import { resolve } from "node:path";
import { backfillInitInfrastructure } from "../template/template.js";
import log from "../util/logger.js";
import { chownMindDir } from "./isolation.js";
import { mindDir, readAllMinds } from "./registry.js";

const mlog = log.child("migrate");

/**
 * One-time on-disk repair for `.init/` infrastructure files a mind never received.
 *
 * `.init/` is stripped from the upgrade's template branch so the merge can never
 * overwrite a mind's identity files. That exclusion also blocked `.local/` hooks
 * and bin shims, which no mind authored — so any capability shipped as a new hook
 * reached only minds created after it existed, while the daemon-side half shipped
 * and looked healthy. `home/.local/hooks/pre-prompt/notices.ts` is the sole reader
 * of the next-turn system-event drain, so minds predating it were silently deaf to
 * every crash notice, delivery failure, and extension notice ever recorded for them
 * (#808 — 11 events, four minds, zero deliveries).
 *
 * This runs at startup rather than only on upgrade because upgrade does not reach
 * every mind: `selectEligible` in auto-upgrade skips the spirit, seeds, variants,
 * and any mind with `"upgrades": "manual"`. On the production host the spirit was
 * one of the deaf minds, so an upgrade-only fix would have left it deaf
 * indefinitely. Same reasoning as {@link migrateNamePlaceholders}.
 *
 * Adds only what is missing and never overwrites, so it is safe and idempotent —
 * a mind that edited its own hook keeps its version. Non-fatal per mind.
 */
export async function migrateInitInfrastructure(): Promise<void> {
  const entries = await readAllMinds();
  for (const entry of entries) {
    const dir = entry.dir ?? mindDir(entry.name);
    const template = entry.template ?? "claude";
    try {
      const added = backfillInitInfrastructure(resolve(dir, "home"), template, entry.name);
      if (added.length > 0) {
        mlog.info(
          `added ${added.length} missing infrastructure file(s) for ${entry.name}: ${added.join(", ")}`,
        );
        // The daemon writes these as root under `user` isolation; hand them to
        // the mind so it can read, run, and edit its own hooks.
        await chownMindDir(dir, entry.name);
      }
    } catch (err) {
      mlog.warn(
        `failed to backfill infrastructure files for ${entry.name} — it may be unable to ` +
          "receive next-turn system events",
        log.errorData(err),
      );
    }
  }
}
