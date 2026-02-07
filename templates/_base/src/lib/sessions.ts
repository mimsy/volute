import { readFileSync } from "node:fs";

export type SessionRule = {
  session: string;
  [key: string]: string; // all other keys are match criteria
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
 * Returns the session name (with template variables expanded).
 */
export function resolveSession(
  config: SessionConfig,
  meta: { channel?: string; sender?: string },
): string {
  const fallback = config.default ?? "main";
  if (!config.rules) return fallback;

  for (const rule of config.rules) {
    if (ruleMatches(rule, meta)) {
      return expandTemplate(rule.session, meta);
    }
  }

  return fallback;
}

function ruleMatches(rule: SessionRule, meta: { channel?: string; sender?: string }): boolean {
  for (const [key, pattern] of Object.entries(rule)) {
    if (key === "session") continue;
    const value = (meta as Record<string, string | undefined>)[key] ?? "";
    if (!globMatch(pattern, value)) return false;
  }
  return true;
}

function expandTemplate(template: string, meta: { channel?: string; sender?: string }): string {
  return template
    .replace(/\$\{sender\}/g, meta.sender ?? "unknown")
    .replace(/\$\{channel\}/g, meta.channel ?? "unknown");
}
