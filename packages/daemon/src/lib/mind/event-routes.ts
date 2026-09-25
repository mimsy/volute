import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  MIND_LEVEL_THREAD,
  recordNotice,
  supersedeUndeliveredEvents,
} from "../chat/system-events.js";
import {
  type BatchConfig,
  clearConfigCache,
  DEFAULT_BATCH_DEBOUNCE,
  DEFAULT_BATCH_MAX_WAIT,
  forgetReportedRoutesProblems,
  ROUTES_PROBLEMS_REASON,
  type RoutingConfig,
} from "../delivery/delivery-router.js";
import log from "../util/logger.js";
import { mindFileOwner } from "./isolation.js";
import { type MindFileOwner, rewriteMindFileInPlace } from "./mind-file-write.js";
import { getBaseName } from "./registry.js";
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

/**
 * The thread configs a {@link migrateThreadBatchToDelivery} run rewrote, keyed by thread
 * pattern, each with the batch settings it now runs under.
 */
export type MigratedThreadBatch = { pattern: string; batch: BatchConfig };

/**
 * Object-level form of the migration: each `threads.<pattern>.batch` object becomes
 * `delivery: { mode: "batch", ...same fields }`, in the same key position. A thread that
 * already has a `delivery`, or whose `batch` isn't an object, is left as the mind wrote
 * it — there is no faithful rewrite, and the router's config-problem notice names it.
 */
function renameThreadBatch(config: RoutingConfig): {
  config: RoutingConfig;
  migrated: MigratedThreadBatch[];
} {
  const threads = config.threads;
  const migrated: MigratedThreadBatch[] = [];
  if (threads == null || typeof threads !== "object" || Array.isArray(threads)) {
    return { config, migrated };
  }
  const nextThreads: Record<string, unknown> = {};
  for (const [pattern, tc] of Object.entries(threads as Record<string, unknown>)) {
    const t = tc as Record<string, unknown> | null;
    const batch = t?.batch;
    if (
      t == null ||
      typeof t !== "object" ||
      "delivery" in t ||
      batch == null ||
      typeof batch !== "object" ||
      Array.isArray(batch)
    ) {
      nextThreads[pattern] = tc;
      continue;
    }
    migrated.push({ pattern, batch: batch as BatchConfig });
    nextThreads[pattern] = Object.fromEntries(
      Object.entries(t).map(([k, v]) =>
        k === "batch" ? ["delivery", { mode: "batch", ...(v as object) }] : [k, v],
      ),
    );
  }
  return { config: { ...config, threads: nextThreads as RoutingConfig["threads"] }, migrated };
}

/** Index just past the `}` closing the object whose `{` is at `open`, respecting strings. */
function closingBrace(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === "\\") i++;
    } else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return i + 1;
  }
  return -1;
}

/**
 * Text-level form of the migration, so the rest of the mind's file keeps its bytes: in the
 * `threads` object only, `"batch": {` becomes `"delivery": { "mode": "batch",`. The caller
 * checks the result parses to exactly what {@link renameThreadBatch} produced and falls back
 * to a re-serialization otherwise, so this only has to be right in the common case.
 */
function renameThreadBatchText(text: string): string {
  const m = /"threads"\s*:\s*\{/.exec(text);
  if (!m) return text;
  const start = m.index + m[0].length - 1;
  const end = closingBrace(text, start);
  if (end === -1) return text;
  const span = text
    .slice(start, end)
    .replace(/"batch"(\s*):(\s*)\{/g, '"delivery"$1:$2{ "mode": "batch",');
  return text.slice(0, start) + span + text.slice(end);
}

/**
 * Repair routes.json thread configs written with `batch` — the key rules use — where the
 * router reads `delivery`. The template shipped `threads."#*".batch` for months, so every
 * mind's channel batching was inert and each channel message woke it immediately. The
 * rewrite is surgical (see {@link renameThreadBatchText}); returns what was migrated,
 * empty when there was nothing to do, which also makes a second run a no-op.
 *
 * The write goes through {@link rewriteMindFileInPlace}, which refuses symlinks, hard
 * links, and a `.config/` that resolves outside the mind dir.
 */
export async function migrateThreadBatchToDelivery(
  dir: string,
  name?: string,
  owner: MindFileOwner | null = null,
): Promise<MigratedThreadBatch[]> {
  let migrated: MigratedThreadBatch[] = [];
  const wrote = await rewriteMindFileInPlace(dir, routesPath(dir), repair, owner);
  function repair(text: string): string | null {
    let parsed: RoutingConfig;
    try {
      parsed = JSON.parse(text);
    } catch {
      return null; // the router reports an unreadable file; nothing to rename in it
    }
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const result = renameThreadBatch(parsed);
    if (result.migrated.length === 0) return null;
    migrated = result.migrated;

    const out = renameThreadBatchText(text);
    let surgical = true;
    try {
      surgical = isDeepStrictEqual(JSON.parse(out), result.config);
    } catch {
      surgical = false;
    }
    return surgical ? out : `${JSON.stringify(result.config, null, 2)}\n`;
  }
  if (!wrote) return [];
  // Not a rule change — nothing gated needs re-evaluating.
  if (name) clearConfigCache(name, { notify: false });
  rlog.info(
    `renamed threads.*.batch → delivery in routes.json${name ? ` for ${name}` : ""}: ` +
      migrated.map((m) => m.pattern).join(", "),
  );
  return migrated;
}

/** What batching a migrated thread now does, in the mind's terms. */
function describeBatch({ pattern, batch }: MigratedThreadBatch): string {
  const debounce = batch.debounce ?? DEFAULT_BATCH_DEBOUNCE;
  const maxWait = batch.maxWait ?? DEFAULT_BATCH_MAX_WAIT;
  const triggers = batch.triggers?.length
    ? `, or at once when a message contains ${batch.triggers.map((t) => `"${t}"`).join(" or ")}`
    : "";
  return (
    `- threads matching ${JSON.stringify(pattern)}: messages collect until ${debounce}s pass ` +
    `with no new one, or ${maxWait}s after the first at most${triggers}, then arrive together.`
  );
}

/**
 * Run {@link migrateThreadBatchToDelivery} for a mind and tell it: its channel messages
 * will now arrive batched rather than one wake per message, and a mind not told that
 * would read the new rhythm as something broken. Never throws — callers are upgrade
 * paths whose own outcome must not hinge on this.
 */
export async function repairThreadBatchConfig(dir: string, name: string): Promise<void> {
  let migrated: MigratedThreadBatch[];
  try {
    migrated = await migrateThreadBatchToDelivery(
      dir,
      name,
      await mindFileOwner(await getBaseName(name)),
    );
  } catch (err) {
    rlog.warn(`failed to migrate thread batch config for ${name}`, log.errorData(err));
    return;
  }
  if (migrated.length === 0) return;
  // An unread "routes.json has settings the router ignores" notice may name the very key
  // just repaired; delivered alongside this one it would tell the mind something false
  // about its own config. Withdraw it, and forget what it reported so anything in it that
  // is still true gets reported again when the config is next read.
  try {
    const withdrawn = await supersedeUndeliveredEvents(name, ROUTES_PROBLEMS_REASON);
    const problems = withdrawn.flatMap((m) =>
      Array.isArray(m.problems) ? m.problems.filter((p) => typeof p === "string") : [],
    );
    if (problems.length > 0) {
      forgetReportedRoutesProblems(name, problems);
      clearConfigCache(name, { notify: false });
    }
  } catch (err) {
    rlog.warn(`failed to withdraw stale routes notices for ${name}`, log.errorData(err));
  }
  try {
    await recordNotice({
      mind: name,
      thread: MIND_LEVEL_THREAD,
      kind: "routes",
      reason: "thread_batch_repaired",
      detail:
        `Your channel batching in .config/routes.json never took effect: it was written as ` +
        `\`batch\` under \`threads\`, where the router reads \`delivery\`, so every message ` +
        `woke you on its own. Volute renamed it to \`delivery: { "mode": "batch", ... }\` with ` +
        `your settings unchanged, and it applies from now on:\n\n` +
        `${migrated.map(describeBatch).join("\n")}\n\n` +
        `Nothing else in the file was touched. To change or drop it, edit the \`delivery\` ` +
        `field — \`"immediate"\` turns batching off for that thread.`,
    });
  } catch (err) {
    rlog.warn(`failed to tell ${name} about its repaired batch config`, log.errorData(err));
  }
}
