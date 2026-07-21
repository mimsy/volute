import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import log from "../util/logger.js";
import { mindDir, readAllMinds } from "./registry.js";

const mlog = log.child("migrate");

/**
 * One-time on-disk repair for the `{{name}}` placeholder that template `.init/`
 * files shipped unsubstituted. `applyInitFiles()` overlays `.init/` onto `home/`
 * *after* copyTemplateToDir() runs its substitution pass, so a `.init/` file the
 * manifest listed under its `home/` path was substituted and then overwritten by
 * the raw `.init/` copy. Every mind ever created therefore got
 * `"triggers": ["@{{name}}"]` in `home/.config/routes.json` — a batch trigger
 * that can never match (matchesTrigger does a substring test against message
 * text), so an @-mention in a #channel never flushed the batch early and the
 * mind only ever answered after the full debounce/maxWait.
 *
 * The template fix only helps new minds: `home/.config/routes.json` is
 * mind-owned and the upgrade merge deliberately never touches it, so existing
 * minds would keep the dead trigger forever. This rewrites the literal string in
 * place. Safe and idempotent — `{{name}}` is a template artifact no mind would
 * author on purpose, and a repaired file no longer contains it.
 *
 * Runs on daemon startup for every registered mind, alongside
 * migrateThreadConfigs().
 */
export async function migrateNamePlaceholders(): Promise<void> {
  const entries = await readAllMinds();
  for (const entry of entries) {
    const dir = entry.dir ?? mindDir(entry.name);
    const path = resolve(dir, "home/.config/routes.json");
    try {
      const raw = readFileSync(path, "utf-8");
      if (!raw.includes("{{name}}")) continue;
      writeFileSync(path, raw.replaceAll("{{name}}", entry.name));
      mlog.info(`substituted leftover {{name}} placeholder in routes.json for ${entry.name}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue; // no routes.json
      mlog.warn(
        `failed to substitute {{name}} in routes.json for ${entry.name} — ` +
          "channel batch triggers will not match a mention of its name",
        log.errorData(err),
      );
    }
  }
}
