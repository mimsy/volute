import { readFileSync } from "node:fs";
import { log } from "./logger.js";

export type BatchConfig = {
  debounce?: number; // seconds of quiet before flush
  maxWait?: number; // max seconds before forced flush
  triggers?: string[]; // patterns that cause immediate flush
};

export type RoutingRule = {
  session?: string;
  destination?: "mind" | "file";
  path?: string; // file path for file destination
  channel?: string;
  sender?: string;
  isDM?: boolean; // match on isDM metadata
  participants?: number; // match on participant count (e.g. 2 = DM)
};

export type SessionConfig = {
  autoReply?: boolean;
  batch?: number | BatchConfig;
  interrupt?: boolean;
  instructions?: string;
};

export type ResolvedSessionConfig = {
  autoReply: boolean;
  batch?: BatchConfig;
  interrupt: boolean;
  instructions?: string;
};

export type RoutingConfig = {
  rules?: RoutingRule[];
  sessions?: Record<string, SessionConfig>;
  default?: string;
  gateUnmatched?: boolean;
};

export type ResolvedRoute =
  | {
      destination: "mind";
      session: string;
      matched: boolean;
    }
  | { destination: "file"; path: string; matched: boolean };

/** Normalize batch config: number (minutes) → { maxWait } in seconds. */
export function normalizeBatch(batch: number | BatchConfig): BatchConfig {
  if (typeof batch === "number") return { maxWait: batch * 60 };
  return batch;
}

export function loadRoutingConfig(configPath: string): RoutingConfig {
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf-8"));
    // Normalize flat arrays (e.g. [{channel, session}, ...]) to { rules: [...] }
    if (Array.isArray(parsed)) return { rules: parsed };
    return parsed;
  } catch (err: any) {
    if (err?.code !== "ENOENT") {
      log("routing", `failed to load ${configPath}:`, err);
    }
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

const GLOB_MATCH_KEYS = new Set(["channel", "sender"]);
const NON_MATCH_KEYS = new Set(["session", "destination", "path"]);

type MatchMeta = { channel?: string; sender?: string; isDM?: boolean; participantCount?: number };

function ruleMatches(rule: RoutingRule, meta: MatchMeta): boolean {
  for (const [key, pattern] of Object.entries(rule)) {
    if (NON_MATCH_KEYS.has(key)) continue;

    // Boolean match: isDM
    if (key === "isDM") {
      if (typeof pattern !== "boolean") return false;
      if ((meta.isDM ?? false) !== pattern) return false;
      continue;
    }

    // Numeric match: participants
    if (key === "participants") {
      if (typeof pattern !== "number") return false;
      if ((meta.participantCount ?? 0) !== pattern) return false;
      continue;
    }

    // Glob string match: channel, sender
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

/**
 * Resolve the full route for a message: destination type, session/path, interrupt, batch.
 */
export function resolveRoute(config: RoutingConfig, meta: MatchMeta): ResolvedRoute {
  const fallback = config.default ?? "main";

  if (!config.rules) {
    return { destination: "mind", session: fallback, matched: false };
  }

  for (const rule of config.rules) {
    if (ruleMatches(rule, meta)) {
      if (rule.destination === "file") {
        if (!rule.path) {
          log("routing", `file destination rule missing path — falling through`);
          continue;
        }
        return { destination: "file", path: rule.path, matched: true };
      }
      return {
        destination: "mind",
        session: sanitizeSessionName(expandTemplate(rule.session ?? fallback, meta)),
        matched: true,
      };
    }
  }

  return { destination: "mind", session: fallback, matched: false };
}

/**
 * Resolve session config by matching session name against glob-pattern keys in config.sessions.
 * First match wins. Returns defaults if no match.
 */
export function resolveSessionConfig(
  config: RoutingConfig,
  sessionName: string,
): ResolvedSessionConfig {
  const defaults: ResolvedSessionConfig = { autoReply: false, interrupt: true };

  if (!config.sessions) return defaults;

  for (const [pattern, sessionConfig] of Object.entries(config.sessions)) {
    if (globMatch(pattern, sessionName)) {
      const batch = sessionConfig.batch != null ? normalizeBatch(sessionConfig.batch) : undefined;
      if (sessionConfig.autoReply && batch != null) {
        log("routing", `autoReply is not supported with batch mode — autoReply will be ignored`);
      }
      return {
        autoReply: batch != null ? false : (sessionConfig.autoReply ?? false),
        batch,
        interrupt: sessionConfig.interrupt ?? true,
        instructions: sessionConfig.instructions,
      };
    }
  }

  return defaults;
}

function sanitizeSessionName(name: string): string {
  return name.replace(/\0/g, "").replace(/[/\\]/g, "-").replace(/\.\./g, "-").slice(0, 100);
}
