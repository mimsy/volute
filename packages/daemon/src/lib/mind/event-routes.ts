import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { clearConfigCache, type RoutingConfig } from "../delivery/delivery-router.js";
import log from "../util/logger.js";
import { readVoluteConfig, writeVoluteConfig } from "./volute-config.js";

const rlog = log.child("event-routes");

function routesPath(dir: string): string {
  return resolve(dir, "home/.config/routes.json");
}

/** Read a mind's routes.json, tolerating a missing or corrupt file (→ `{}`). */
export function readRoutesConfig(dir: string): RoutingConfig {
  const path = routesPath(dir);
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (err) {
    rlog.warn(`unreadable routes.json in ${dir} — treating as empty`, log.errorData(err));
    return {};
  }
}

function writeRoutesConfig(dir: string, config: RoutingConfig, name?: string): void {
  const path = routesPath(dir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  // Drop the router's cached copy so new rules take effect immediately. No gated-message
  // re-evaluation — event rules never affect channel gating.
  if (name) clearConfigCache(name, { notify: false });
}

/**
 * Ensure the mind's routes.json routes a given event key to `thread`. Idempotent: an
 * existing rule for the exact same `event` key has its thread updated (or the rule removed
 * when `thread` is null); otherwise a new rule is prepended, so a specific event rule wins
 * over any hand-written wildcard. Returns whether the file changed.
 */
export function upsertEventRule(
  dir: string,
  event: string,
  thread: string | null,
  name?: string,
): boolean {
  const config = readRoutesConfig(dir);
  const rules = config.rules ?? [];
  const idx = rules.findIndex((r) => r && typeof r === "object" && r.event === event);
  if (thread == null) {
    if (idx === -1) return false;
    rules.splice(idx, 1);
  } else if (idx !== -1) {
    if (rules[idx].thread === thread) return false;
    rules[idx].thread = thread;
  } else {
    rules.unshift({ event, thread });
  }
  config.rules = rules;
  writeRoutesConfig(dir, config, name);
  return true;
}

/**
 * Move each schedule's legacy `thread` field into an equivalent
 * `{ event: "schedule:<id>", thread }` routes.json rule, then strip the field from
 * volute.json (#736). After this a mind's schedule-fire routing lives in one place —
 * routes.json — editable like any other routing rule.
 *
 * Idempotent: a second run finds no `thread` fields and no-ops. A schedule already covered
 * by a rule keeps that rule (upsert only updates a differing thread). Returns whether
 * anything changed, so a caller can log/reload.
 */
export function migrateScheduleThreadsToRoutes(dir: string, name?: string): boolean {
  const vconfig = readVoluteConfig(dir);
  const threaded = (vconfig?.schedules ?? []).filter(
    (s) => typeof s.thread === "string" && s.thread,
  );
  if (threaded.length === 0) return false;

  for (const s of threaded) {
    upsertEventRule(dir, `schedule:${s.id}`, s.thread as string, name);
    delete s.thread;
  }
  writeVoluteConfig(dir, vconfig as NonNullable<typeof vconfig>);
  rlog.info(
    `migrated ${threaded.length} schedule thread(s) to routes.json${name ? ` for ${name}` : ""}`,
  );
  return true;
}
