import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import log from "../logger.js";
import { mindDir } from "../registry.js";

// --- Types ---

export type RoutingRule = {
  session?: string;
  destination?: "mind" | "file";
  path?: string;
  channel?: string;
  sender?: string;
  isDM?: boolean;
  participants?: number;
  mode?: "all" | "mention";
};

export type BatchConfig = {
  debounce?: number;
  maxWait?: number;
  triggers?: string[];
};

export type SessionConfig = {
  batch?: number | BatchConfig;
  interrupt?: boolean;
  instructions?: string;
  delivery?: DeliveryMode;
};

export type DeliveryMode =
  | "immediate"
  | "batch"
  | { mode: "batch"; debounce?: number; maxWait?: number };

export type RoutingConfig = {
  rules?: RoutingRule[];
  sessions?: Record<string, SessionConfig>;
  default?: string;
  gateUnmatched?: boolean;
};

export type ResolvedRoute =
  | { destination: "mind"; session: string; matched: boolean; mode?: "all" | "mention" }
  | { destination: "file"; path: string; matched: boolean };

export type ResolvedDeliveryMode =
  | { mode: "immediate" }
  | { mode: "batch"; debounce: number; maxWait: number; triggers?: string[] };

export type ResolvedSessionConfig = {
  delivery: ResolvedDeliveryMode;
  interrupt: boolean;
  instructions?: string;
};

export type MatchMeta = {
  channel?: string;
  sender?: string;
  isDM?: boolean;
  participantCount?: number;
};

// --- Delivery payload ---

export interface DeliveryPayload {
  channel: string;
  sender: string | null;
  content: unknown; // string or content block array
  conversationId?: string;
  typing?: string[];
  platform?: string;
  isDM?: boolean;
  participants?: string[];
  participantCount?: number;
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

function configPath(mindName: string): string {
  return resolve(mindDir(mindName), "home/.config/routes.json");
}

export function getRoutingConfig(mindName: string): RoutingConfig {
  const path = configPath(mindName);

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
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    const config: RoutingConfig = Array.isArray(parsed) ? { rules: parsed } : parsed;
    configCache.set(mindName, { config, mtime });
    return config;
  } catch (err) {
    dlog.warn(`failed to load routes.json for ${mindName}`, log.errorData(err));
    configCache.delete(mindName);
    return {};
  }
}

// --- Glob matching ---

const globRegexCache = new Map<string, RegExp>();

export function clearConfigCache(mindName?: string): void {
  if (mindName) {
    configCache.delete(mindName);
    statCheckCache.delete(mindName);
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
const NON_MATCH_KEYS = new Set(["session", "destination", "path", "mode"]);

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
        session: sanitizeSessionName(expandTemplate(rule.session ?? fallback, meta)),
        matched: true,
        mode: rule.mode,
      };
    }
  }

  return { destination: "mind", session: fallback, matched: false };
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
): ResolvedSessionConfig {
  const defaults: ResolvedSessionConfig = {
    delivery: { mode: "immediate" },
    interrupt: true,
  };

  if (!config.sessions) return defaults;

  for (const [pattern, sessionConfig] of Object.entries(config.sessions)) {
    if (globMatch(pattern, sessionName)) {
      // Resolve delivery mode: new `delivery` field takes precedence over legacy `batch`
      let delivery: ResolvedDeliveryMode;

      if (sessionConfig.delivery != null) {
        if (sessionConfig.delivery === "immediate") {
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
          };
        }
      } else if (sessionConfig.batch != null) {
        // Legacy: map batch config to delivery mode
        const batch = normalizeBatchConfig(sessionConfig.batch);
        delivery = {
          mode: "batch",
          debounce: batch.debounce ?? DEFAULT_BATCH_DEBOUNCE,
          maxWait: batch.maxWait ?? DEFAULT_BATCH_MAX_WAIT,
          triggers: batch.triggers,
        };
      } else if (sessionConfig.interrupt === false) {
        // Legacy: interrupt: false implies batch mode
        delivery = {
          mode: "batch",
          debounce: DEFAULT_BATCH_DEBOUNCE,
          maxWait: DEFAULT_BATCH_MAX_WAIT,
        };
      } else {
        delivery = { mode: "immediate" };
      }

      return {
        delivery,
        interrupt: sessionConfig.interrupt ?? true,
        instructions: sessionConfig.instructions,
      };
    }
  }

  return defaults;
}
