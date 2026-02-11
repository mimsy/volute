import { readFileSync } from "node:fs";
import { log } from "./logger.js";

export type RoutingRule = {
  session?: string;
  destination?: "agent" | "file";
  path?: string; // file path for file destination
  interrupt?: boolean; // interrupt in-progress agent turn (default: true for agent)
  batch?: number; // minutes — buffer messages, flush on timer
  auto?: boolean; // auto-route new conversation sources matching this rule
  channel?: string;
  sender?: string;
  isDM?: boolean; // match on isDM metadata
  participants?: number; // match on participant count (e.g. 2 = DM)
};

export type RoutingConfig = {
  rules?: RoutingRule[];
  default?: string;
  gateUnmatched?: boolean;
};

export type ResolvedRoute =
  | { destination: "agent"; session: string; interrupt: boolean; batch?: number; matched: boolean }
  | { destination: "file"; path: string; matched: boolean };

export function loadRoutingConfig(configPath: string): RoutingConfig {
  try {
    return JSON.parse(readFileSync(configPath, "utf-8"));
  } catch (err: any) {
    if (err?.code !== "ENOENT") {
      log("sessions", `failed to load ${configPath}:`, err);
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
const NON_MATCH_KEYS = new Set(["session", "batch", "destination", "path", "interrupt", "auto"]);

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
    return { destination: "agent", session: fallback, interrupt: true, matched: false };
  }

  for (const rule of config.rules) {
    if (ruleMatches(rule, meta)) {
      if (rule.destination === "file") {
        if (!rule.path) {
          log("sessions", `file destination rule missing path — falling through`);
          continue;
        }
        return { destination: "file", path: rule.path, matched: true };
      }
      return {
        destination: "agent",
        session: sanitizeSessionName(expandTemplate(rule.session ?? fallback, meta)),
        interrupt: rule.interrupt ?? true,
        batch: rule.batch,
        matched: true,
      };
    }
  }

  return { destination: "agent", session: fallback, interrupt: true, matched: false };
}

function sanitizeSessionName(name: string): string {
  return name.replace(/\0/g, "").replace(/[/\\]/g, "-").replace(/\.\./g, "-").slice(0, 100);
}
