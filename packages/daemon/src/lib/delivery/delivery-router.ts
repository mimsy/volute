import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { ParticipantProfile } from "@volute/api";
import { mindDir } from "../mind/registry.js";
import log from "../util/logger.js";

// --- Types ---

export type RoutingRule = {
  thread?: string;
  destination?: "mind" | "file";
  path?: string;
  channel?: string;
  sender?: string;
  isDM?: boolean;
  participants?: number;
  mode?: "all" | "mention";
  batch?: number | BatchConfig;
};

export type BatchConfig = {
  debounce?: number;
  maxWait?: number;
  triggers?: string[];
};

export type SessionConfig = {
  instructions?: string;
  delivery?: DeliveryMode;
  interrupt?: boolean;
};

export type DeliveryMode =
  | "immediate"
  | "batch"
  | { mode: "batch"; debounce?: number; maxWait?: number; triggers?: string[] };

export type RoutingConfig = {
  rules?: RoutingRule[];
  threads?: Record<string, SessionConfig>;
  default?: string;
  gateUnmatched?: boolean;
};

export type ResolvedRoute =
  | {
      destination: "mind";
      session: string;
      matched: boolean;
      mode?: "all" | "mention";
      rule?: RoutingRule;
    }
  | { destination: "file"; path: string; matched: boolean };

export type ResolvedDeliveryMode =
  | { mode: "immediate" }
  | { mode: "batch"; debounce: number; maxWait: number; triggers?: string[] };

export type ResolvedSessionConfig = {
  delivery: ResolvedDeliveryMode;
  instructions?: string;
  interrupt: boolean;
};

export type MatchMeta = {
  channel?: string;
  sender?: string;
  isDM?: boolean;
  participantCount?: number;
};

// --- Delivery payload ---

export type { ParticipantProfile };

export interface DeliveryPayload {
  channel: string;
  sender: string | null;
  content: unknown; // string or content block array
  conversationId?: string;
  session?: string; // explicit target session — skips route matching
  typing?: string[];
  platform?: string;
  isDM?: boolean;
  participants?: string[];
  participantCount?: number;
  participantProfiles?: ParticipantProfile[];
  whileSleeping?: "skip" | "queue" | "trigger-wake";
}

export function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return (content as { type: string; text?: string }[])
      .filter((p) => p.type === "text" && p.text)
      .map((p) => p.text)
      .join("\n");
  }
  return JSON.stringify(content);
}

// --- Config cache ---

type CachedConfig = { config: RoutingConfig; mtime: number };
const configCache = new Map<string, CachedConfig>();
const statCheckCache = new Map<string, { mtime: number; checkedAt: number }>();
const STAT_TTL_MS = 5_000;

const dlog = log.child("delivery-router");

// Notified when a mind's routes.json changes (explicit cache clear or detected mtime
// change), so held (gated) messages can be re-evaluated against the new rules.
let routesChangeListener: ((mind: string) => void) | undefined;

export function setRoutesChangeListener(fn: ((mind: string) => void) | undefined): void {
  routesChangeListener = fn;
}

function notifyRoutesChanged(mind: string): void {
  if (!routesChangeListener) return;
  try {
    routesChangeListener(mind);
  } catch (err) {
    dlog.warn(`routes change listener failed for ${mind}`, log.errorData(err));
  }
}

// Cache of mind name → directory overrides (e.g. spirits with custom dirs)
const dirOverrides = new Map<string, string>();

/** Register a custom directory for a mind (called when spirits/variants start). */
export function registerMindDir(name: string, dir: string): void {
  dirOverrides.set(name, dir);
}

/**
 * Absolute path of the routes.json the router actually reads for a mind (honouring the
 * spirit/variant directory overrides). Exported so writers — e.g. `acceptChannel` — edit
 * the same file the router loads.
 */
export function routesConfigPath(mindName: string): string {
  const dir = dirOverrides.get(mindName) ?? mindDir(mindName);
  return resolve(dir, "home/.config/routes.json");
}

export function getRoutingConfig(mindName: string): RoutingConfig {
  const path = routesConfigPath(mindName);

  // Skip statSync if we checked recently and have a cached config
  const now = Date.now();
  const statCached = statCheckCache.get(mindName);
  const cached = configCache.get(mindName);
  if (statCached && cached && now - statCached.checkedAt < STAT_TTL_MS) {
    return cached.config;
  }

  let mtime: number;
  try {
    mtime = statSync(path).mtimeMs;
  } catch {
    // No config file — return empty config, don't cache
    configCache.delete(mindName);
    statCheckCache.delete(mindName);
    return {};
  }

  statCheckCache.set(mindName, { mtime, checkedAt: now });

  if (cached && cached.mtime === mtime) {
    return cached.config;
  }

  try {
    const config: RoutingConfig = JSON.parse(readFileSync(path, "utf-8"));
    const changed = cached != null && cached.mtime !== mtime;
    warnUnknownRuleKeys(mindName, config);
    configCache.set(mindName, { config, mtime });
    // A pre-existing cached config with a different mtime means routes.json actually
    // changed — release any gated messages that the new rules now match.
    if (changed) notifyRoutesChanged(mindName);
    return config;
  } catch (err) {
    dlog.warn(`failed to load routes.json for ${mindName}`, log.errorData(err));
    configCache.delete(mindName);
    return {};
  }
}

// --- Glob matching ---

const globRegexCache = new Map<string, RegExp>();

/**
 * Drop a mind's cached routing config (or every mind's, with no argument).
 *
 * Pass `{ notify: false }` when the caller releases gated messages itself and awaits the
 * result — the listener-driven release runs detached, so leaving it on would race the
 * awaited run and make its counts unreliable.
 */
export function clearConfigCache(mindName?: string, opts?: { notify?: boolean }): void {
  if (mindName) {
    configCache.delete(mindName);
    statCheckCache.delete(mindName);
    // An explicit invalidation typically follows a routes.json write — re-evaluate
    // gated messages against the (about to be reloaded) rules.
    if (opts?.notify !== false) notifyRoutesChanged(mindName);
  } else {
    configCache.clear();
    statCheckCache.clear();
    globRegexCache.clear();
  }
}

function globMatch(pattern: string, value: string): boolean {
  let regex = globRegexCache.get(pattern);
  if (!regex) {
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    regex = new RegExp(`^${escaped}$`);
    globRegexCache.set(pattern, regex);
  }
  return regex.test(value);
}

// --- Rule matching ---

const GLOB_MATCH_KEYS = new Set(["channel", "sender"]);
const NON_MATCH_KEYS = new Set(["thread", "destination", "path", "mode", "batch"]);
const KNOWN_RULE_KEYS = new Set([...GLOB_MATCH_KEYS, ...NON_MATCH_KEYS, "isDM", "participants"]);

/**
 * Warn (once per config load, not per message) about rule keys ruleMatches will
 * reject. An unrecognized key makes the whole rule unmatchable — with gating on,
 * that silently diverts the channel's messages into the gate. Catches leftovers
 * from the session→thread rename and future typos alike.
 */
export function warnUnknownRuleKeys(mindName: string, config: RoutingConfig): void {
  if (!Array.isArray(config.rules)) return;
  for (const rule of config.rules) {
    if (rule == null || typeof rule !== "object") continue;
    const unknown = Object.keys(rule).filter((k) => !KNOWN_RULE_KEYS.has(k));
    if (unknown.length > 0) {
      dlog.warn(
        `routes.json for ${mindName} has a rule with unrecognized key(s) ` +
          `${unknown.map((k) => `"${k}"`).join(", ")} — the rule will never match ` +
          `(known keys: ${[...KNOWN_RULE_KEYS].join(", ")})`,
      );
    }
  }
}

function ruleMatches(rule: RoutingRule, meta: MatchMeta): boolean {
  for (const [key, pattern] of Object.entries(rule)) {
    if (NON_MATCH_KEYS.has(key)) continue;

    if (key === "isDM") {
      if (typeof pattern !== "boolean") return false;
      if ((meta.isDM ?? false) !== pattern) return false;
      continue;
    }

    if (key === "participants") {
      if (typeof pattern !== "number") return false;
      if ((meta.participantCount ?? 0) !== pattern) return false;
      continue;
    }

    if (typeof pattern !== "string") return false;
    if (!GLOB_MATCH_KEYS.has(key)) return false;
    const value = meta[key as "channel" | "sender"] ?? "";
    if (!globMatch(pattern, value)) return false;
  }
  return true;
}

function expandTemplate(template: string, meta: MatchMeta): string {
  return template
    .replace(/\$\{sender\}/g, meta.sender ?? "unknown")
    .replace(/\$\{channel\}/g, meta.channel ?? "unknown");
}

function sanitizeSessionName(name: string): string {
  return name.replace(/\0/g, "").replace(/[/\\]/g, "-").replace(/\.\./g, "-").slice(0, 100);
}

// --- Route resolution ---

export function resolveRoute(config: RoutingConfig, meta: MatchMeta): ResolvedRoute {
  const fallback = config.default ?? "main";

  if (!config.rules) {
    return { destination: "mind", session: fallback, matched: false };
  }

  for (const rule of config.rules) {
    if (ruleMatches(rule, meta)) {
      if (rule.destination === "file") {
        if (!rule.path) {
          dlog.warn("file destination rule missing path — falling through");
          continue;
        }
        return { destination: "file", path: rule.path, matched: true };
      }
      return {
        destination: "mind",
        session: sanitizeSessionName(expandTemplate(rule.thread ?? fallback, meta)),
        matched: true,
        mode: rule.mode,
        rule,
      };
    }
  }

  return { destination: "mind", session: fallback, matched: false };
}

/**
 * Whether a resolved route should be gated: the channel is unrouted and gating is on, so
 * the message is held until the mind opts in. A gated message is never delivered to the
 * mind, so callers must NOT record it as inbound history — the mind hasn't seen it (#420).
 * File routes and explicitly-matched rules are never gated.
 */
export function shouldGate(config: RoutingConfig, route: ResolvedRoute): boolean {
  return route.destination === "mind" && !route.matched && config.gateUnmatched !== false;
}

// --- Delivery mode resolution ---

const DEFAULT_BATCH_DEBOUNCE = 5;
const DEFAULT_BATCH_MAX_WAIT = 120;

function normalizeBatchConfig(batch: number | BatchConfig): BatchConfig {
  if (typeof batch === "number") return { maxWait: batch * 60 };
  return batch;
}

export function resolveDeliveryMode(
  config: RoutingConfig,
  sessionName: string,
  rule?: RoutingRule,
): ResolvedSessionConfig {
  // Rule-level batch config takes priority when no threads config exists
  const ruleBatch = rule?.batch;
  const defaults: ResolvedSessionConfig = {
    delivery: { mode: "immediate" },
    interrupt: false,
  };

  if (!config.threads) {
    if (ruleBatch != null) {
      const batch = normalizeBatchConfig(ruleBatch);
      return {
        delivery: {
          mode: "batch",
          debounce: batch.debounce ?? DEFAULT_BATCH_DEBOUNCE,
          maxWait: batch.maxWait ?? DEFAULT_BATCH_MAX_WAIT,
          triggers: batch.triggers,
        },
        interrupt: false,
      };
    }
    return defaults;
  }

  for (const [pattern, sessionConfig] of Object.entries(config.threads)) {
    if (globMatch(pattern, sessionName)) {
      let delivery: ResolvedDeliveryMode;

      if (sessionConfig.delivery == null || sessionConfig.delivery === "immediate") {
        delivery = { mode: "immediate" };
      } else if (sessionConfig.delivery === "batch") {
        delivery = {
          mode: "batch",
          debounce: DEFAULT_BATCH_DEBOUNCE,
          maxWait: DEFAULT_BATCH_MAX_WAIT,
        };
      } else {
        delivery = {
          mode: "batch",
          debounce: sessionConfig.delivery.debounce ?? DEFAULT_BATCH_DEBOUNCE,
          maxWait: sessionConfig.delivery.maxWait ?? DEFAULT_BATCH_MAX_WAIT,
          triggers: sessionConfig.delivery.triggers,
        };
      }

      return {
        delivery,
        instructions: sessionConfig.instructions,
        interrupt: sessionConfig.interrupt ?? false,
      };
    }
  }

  // No session-level config matched — fall back to rule-level batch
  if (ruleBatch != null) {
    const batch = normalizeBatchConfig(ruleBatch);
    return {
      delivery: {
        mode: "batch",
        debounce: batch.debounce ?? DEFAULT_BATCH_DEBOUNCE,
        maxWait: batch.maxWait ?? DEFAULT_BATCH_MAX_WAIT,
        triggers: batch.triggers,
      },
      interrupt: false,
    };
  }

  return defaults;
}
