import { readFileSync } from "node:fs";

export type SessionRule = {
  session: string;
  batch?: number; // minutes — buffer messages, flush on timer
  channel?: string;
  sender?: string;
};

export type SessionConfig = {
  rules?: SessionRule[];
  default?: string;
};

export function loadSessionConfig(configPath: string): SessionConfig {
  try {
    return JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    return {};
  }
}

/**
 * Match a glob-like pattern against a string.
 * Supports only `*` as wildcard (matches any sequence of characters).
 */
function globMatch(pattern: string, value: string): boolean {
  // Escape regex special chars except *, then replace * with .*
  const regex = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${regex}$`).test(value);
}

/**
 * Resolve which session a message should route to based on the config.
 * Returns the session name (with template variables expanded, path-safe).
 */
export function resolveSession(
  config: SessionConfig,
  meta: { channel?: string; sender?: string },
): string {
  const fallback = config.default ?? "main";
  if (!config.rules) return fallback;

  for (const rule of config.rules) {
    if (ruleMatches(rule, meta)) {
      return sanitizeSessionName(expandTemplate(rule.session, meta));
    }
  }

  return fallback;
}

const MATCH_KEYS = new Set(["channel", "sender"]);

function ruleMatches(rule: SessionRule, meta: { channel?: string; sender?: string }): boolean {
  for (const [key, pattern] of Object.entries(rule)) {
    if (key === "session" || key === "batch") continue;
    if (typeof pattern !== "string") return false;
    if (!MATCH_KEYS.has(key)) return false;
    const value = meta[key as keyof typeof meta] ?? "";
    if (!globMatch(pattern, value)) return false;
  }
  return true;
}

function expandTemplate(template: string, meta: { channel?: string; sender?: string }): string {
  return template
    .replace(/\$\{sender\}/g, meta.sender ?? "unknown")
    .replace(/\$\{channel\}/g, meta.channel ?? "unknown");
}

/**
 * Resolve the batch interval (in minutes) for a message based on the config.
 * Returns undefined if no matching rule has a batch value.
 */
export function resolveBatch(
  config: SessionConfig,
  meta: { channel?: string; sender?: string },
): number | undefined {
  if (!config.rules) return undefined;

  for (const rule of config.rules) {
    if (ruleMatches(rule, meta)) {
      return rule.batch;
    }
  }

  return undefined;
}

function sanitizeSessionName(name: string): string {
  return name.replace(/\0/g, "").replace(/[/\\]/g, "-").replace(/\.\./g, "-").slice(0, 100);
}
