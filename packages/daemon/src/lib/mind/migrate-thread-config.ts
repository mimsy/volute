import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import log from "../util/logger.js";
import { mindDir, readAllMinds } from "./registry.js";

const mlog = log.child("migrate");

/**
 * One-time on-disk migration for the session→thread rename (#493) in files the
 * daemon does NOT own — each mind's `home/.config/routes.json` and
 * `home/.config/volute.json`. Without this, a pre-rename rule like
 * `{ "channel": "*", "session": "..." }` doesn't just lose its thread target:
 * ruleMatches rejects the whole rule on the unknown `session` key, and with
 * gateUnmatched defaulting on, every message the rule used to route gets gated.
 *
 * Runs on daemon startup for every registered mind (idempotent — a migrated
 * file is left untouched). Follows the existing startup-migration precedent
 * (migrateConfigSecrets, avatar sizes, system-user role).
 */

/** Rename `session` → `thread` on one object (rule or schedule). Returns true if changed. */
function renameSessionKey(obj: Record<string, unknown>): boolean {
  if (obj == null || typeof obj !== "object" || !("session" in obj)) return false;
  // If both keys exist, `thread` wins — but the stale `session` key must still
  // go (an unknown rule key makes the whole rule unmatchable).
  if (!("thread" in obj)) obj.thread = obj.session;
  delete obj.session;
  return true;
}

/** Migrate a parsed routes.json config in place. Returns true if changed. */
export function migrateRoutesConfig(config: unknown): boolean {
  if (config == null || typeof config !== "object") return false;
  let changed = false;

  // Flat-array form: [{channel, session}, ...]
  const rules = Array.isArray(config) ? config : (config as { rules?: unknown }).rules;
  if (Array.isArray(rules)) {
    for (const rule of rules) {
      if (renameSessionKey(rule)) changed = true;
    }
  }

  // Top-level thread-config map: `sessions` → `threads`
  if (!Array.isArray(config)) {
    const cfg = config as Record<string, unknown>;
    if ("sessions" in cfg) {
      if (!("threads" in cfg)) cfg.threads = cfg.sessions;
      delete cfg.sessions;
      changed = true;
    }
  }

  return changed;
}

/** Migrate a parsed volute.json config in place. Returns true if changed. */
export function migrateVoluteConfig(config: unknown): boolean {
  if (config == null || typeof config !== "object" || Array.isArray(config)) return false;
  const schedules = (config as { schedules?: unknown }).schedules;
  if (!Array.isArray(schedules)) return false;
  let changed = false;
  for (const schedule of schedules) {
    if (renameSessionKey(schedule)) changed = true;
  }
  return changed;
}

function migrateJsonFile(path: string, migrate: (config: unknown) => boolean): boolean {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return false; // no file — nothing to migrate
  }
  const config = JSON.parse(raw); // parse errors propagate to the caller's warn
  if (!migrate(config)) return false;
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  return true;
}

/** Run the session→thread config migration for every registered mind. */
export async function migrateThreadConfigs(): Promise<void> {
  const entries = await readAllMinds();
  for (const entry of entries) {
    const dir = entry.dir ?? mindDir(entry.name);
    for (const [file, migrate] of [
      ["routes.json", migrateRoutesConfig],
      ["volute.json", migrateVoluteConfig],
    ] as const) {
      const path = resolve(dir, "home/.config", file);
      try {
        if (migrateJsonFile(path, migrate)) {
          mlog.info(`migrated legacy session keys to thread in ${file} for ${entry.name}`);
        }
      } catch (err) {
        mlog.warn(
          `failed to migrate ${file} for ${entry.name} — legacy "session" keys may stop matching`,
          log.errorData(err),
        );
      }
    }
  }
}
