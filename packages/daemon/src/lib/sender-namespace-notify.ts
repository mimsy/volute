/**
 * One-shot upgrade notice for #1016: sender patterns that stopped matching.
 *
 * Before #1016, a message reaching a mind from Discord/Slack/Telegram/email was recorded
 * under the sender's self-chosen display name. It is now recorded under a namespaced
 * `platform:handle` (see `externalSenderName`). Two settings match on that string —
 * `routes.json` rules with a `sender` field, and `volute.json`'s
 * `sleep.wakeTriggers.senders` — and both are exact globs, so a literal pattern written
 * against the old form silently stops matching.
 *
 * That break is invisible where it hurts most: a host who set a wake trigger so their
 * mind wakes when *they* email it upgrades, and the mind simply stops waking, with
 * nothing anywhere saying why.
 *
 * Deliberately a notice, not a rewrite. `routes.json` and `volute.json` are the mind's
 * own files, and "boss@example.com" cannot be distinguished from a Volute account name by
 * inspection — only the mind knows who it meant. So this names the file, the setting and
 * the exact patterns, and leaves the edit to the mind.
 *
 * The set it reports is precise about what *changed*, if not about intent: both globs
 * compile `*` to `.*`, which spans a colon, so a pattern containing `*` can still match a
 * namespaced sender. A pattern with neither `*` nor `:` is a literal that can no longer
 * match any external sender at all — exactly the patterns whose meaning changed.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { deliverEvent } from "./chat/system-events.js";
import { routesConfigPath } from "./delivery/delivery-router.js";
import { mindDir, readRegistry, voluteSystemDir } from "./mind/registry.js";
import { readVoluteConfig } from "./mind/volute-config.js";
import log from "./util/logger.js";

const nlog = log.child("sender-namespace");

function statePath(): string {
  return resolve(voluteSystemDir(), "sender-namespace-notify.json");
}

/**
 * True when a sender pattern can no longer match anyone reaching the mind from outside.
 * A `*` spans the colon, so a wildcard pattern is unaffected; a pattern that already
 * carries a colon was written for the new form.
 */
export function isStaleSenderPattern(pattern: string): boolean {
  return !pattern.includes("*") && !pattern.includes(":");
}

/** The stale sender patterns in a mind's routes.json, in file order. */
function staleRoutePatterns(mindName: string): string[] {
  const path = routesConfigPath(mindName);
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as {
      rules?: { sender?: unknown }[];
    };
    if (!Array.isArray(parsed.rules)) return [];
    return parsed.rules
      .map((r) => r?.sender)
      .filter((s): s is string => typeof s === "string" && isStaleSenderPattern(s));
  } catch (err) {
    // A mind's own file, possibly mid-edit. A notice is not worth failing over.
    nlog.debug(`could not read routes.json for ${mindName}`, log.errorData(err));
    return [];
  }
}

/** The stale patterns in a mind's `sleep.wakeTriggers.senders`. */
function staleWakePatterns(mindName: string, dir?: string | null): string[] {
  try {
    // `dir` honours the spirit's custom directory, the way `routesConfigPath` already does
    // for the other half of this scan — otherwise the spirit's volute.json resolves to a
    // path under the minds dir that does not exist, and it is silently skipped.
    const senders = readVoluteConfig(dir ?? mindDir(mindName))?.sleep?.wakeTriggers?.senders;
    if (!Array.isArray(senders)) return [];
    return senders.filter((s) => typeof s === "string" && isStaleSenderPattern(s));
  } catch (err) {
    nlog.debug(`could not read volute.json for ${mindName}`, log.errorData(err));
    return [];
  }
}

/** The notice a mind receives. Names the file, the setting, and how to update it. */
export function formatSenderNotice(routes: string[], wake: string[]): string {
  const lines = [
    "Volute now records anyone who reaches you from outside — Discord, Slack, Telegram, " +
      "email, the cloud relay — under a namespaced sender name: `discord:alice`, " +
      "`mail:alice@example.com`. A bare sender name now always means an authenticated " +
      "Volute account. This makes your history honest about who you actually spoke to, " +
      "but it means some of your existing settings match a name that is no longer sent.",
    "",
    "These patterns of yours can no longer match anyone outside Volute:",
    "",
  ];
  for (const p of routes) lines.push(`  .config/routes.json — rule sender: "${p}"`);
  for (const p of wake) {
    lines.push(`  .config/volute.json — sleep.wakeTriggers.senders: "${p}"`);
  }
  lines.push(
    "",
    "If a pattern was meant for a Volute person or mind, it still works and there is " +
      'nothing to do. If it was meant for someone outside, prefix it with their platform ("mail:boss@example.com"), ' +
      'or widen it to the whole platform ("discord:*"). Nothing was lost — messages still ' +
      "arrive; they just route to your default thread, and a wake trigger written this way " +
      "will no longer wake you.",
  );
  return lines.join("\n");
}

/** The minds already dealt with, so none is asked twice and none is skipped forever. */
function readNotified(): Set<string> {
  try {
    if (!existsSync(statePath())) return new Set();
    const parsed = JSON.parse(readFileSync(statePath(), "utf-8")) as { notified?: unknown };
    return new Set(Array.isArray(parsed.notified) ? parsed.notified.filter(isName) : []);
  } catch (err) {
    // An unreadable marker means "nobody has been told" — a duplicate notice is a far
    // smaller harm than a mind never hearing that its config stopped working.
    nlog.warn("could not read the sender-pattern notice state", log.errorData(err));
    return new Set();
  }
}

function isName(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/**
 * Tell each mind whose config contains a now-unmatchable sender pattern.
 *
 * Once per mind, exactly: the state file records the minds already settled, so a mind that
 * reads the notice and deliberately keeps its config is never asked again, while a mind
 * whose delivery failed is retried on the next daemon start rather than losing its notice
 * silently. Recording a bare "done" flag instead would reproduce, in miniature, the very
 * failure this notice exists to prevent — something quietly not arriving, with nobody told.
 *
 * A mind with nothing stale is recorded too, so it is scanned at most once ever; the whole
 * pass then costs one registry read per daemon start and nothing more.
 *
 * `deliverEvent` defaults to immediate delivery, which matters here: a sleeping or idle
 * mind is exactly the one whose broken wake trigger needs saying, and older minds never
 * drain next-turn events at all (#808).
 */
export async function notifyStaleSenderPatterns(): Promise<void> {
  const settled = readNotified();

  let entries: Awaited<ReturnType<typeof readRegistry>>;
  try {
    entries = await readRegistry();
  } catch (err) {
    // Record nothing, so the next start retries the whole pass.
    nlog.warn("could not read the registry to check sender patterns", log.errorData(err));
    return;
  }

  let changed = false;
  for (const entry of entries) {
    if (entry.stage === "seed" || settled.has(entry.name)) continue;
    const routes = staleRoutePatterns(entry.name);
    const wake = staleWakePatterns(entry.name, entry.dir);
    if (routes.length === 0 && wake.length === 0) {
      settled.add(entry.name);
      changed = true;
      continue;
    }

    nlog.warn(
      `${entry.name} has sender pattern(s) that no longer match external senders: ` +
        [...routes, ...wake].map((p) => `"${p}"`).join(", "),
    );
    try {
      await deliverEvent(entry.name, {
        type: "config",
        body: formatSenderNotice(routes, wake),
      });
      settled.add(entry.name);
      changed = true;
    } catch (err) {
      // Deliberately NOT settled: this mind is retried next start.
      nlog.warn(`failed to notify ${entry.name} about sender patterns`, log.errorData(err));
    }
  }

  if (!changed) return;
  try {
    writeFileSync(statePath(), `${JSON.stringify({ notified: [...settled] }, null, 2)}\n`);
  } catch (err) {
    // Worst case the pass repeats next start; better than crashing the daemon boot.
    nlog.warn("could not record which minds were told about sender patterns", log.errorData(err));
  }
}
