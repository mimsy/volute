import { readFileSync } from "node:fs";
import { log } from "./logger.js";

export type SessionRule = {
  session?: string;
  destination?: "agent" | "file";
  path?: string; // file path for file destination
  interrupt?: boolean; // interrupt in-progress agent turn (default: true for agent)
  batch?: number; // minutes — buffer messages, flush on timer
  channel?: string;
  sender?: string;
};

export type SessionConfig = {
  rules?: SessionRule[];
  default?: string;
};

export type ResolvedRoute =
  | { destination: "agent"; session: string; interrupt: boolean; batch?: number }
  | { destination: "file"; path: string };

export function loadSessionConfig(configPath: string): SessionConfig {
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

const MATCH_KEYS = new Set(["channel", "sender"]);
const NON_MATCH_KEYS = new Set(["session", "batch", "destination", "path", "interrupt"]);

function ruleMatches(rule: SessionRule, meta: { channel?: string; sender?: string }): boolean {
  for (const [key, pattern] of Object.entries(rule)) {
    if (NON_MATCH_KEYS.has(key)) continue;
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
 * Resolve the full route for a message: destination type, session/path, interrupt, batch.
 */
export function resolveRoute(
  config: SessionConfig,
  meta: { channel?: string; sender?: string },
): ResolvedRoute {
  const fallback = config.default ?? "main";

  if (!config.rules) {
    return { destination: "agent", session: fallback, interrupt: true };
  }

  for (const rule of config.rules) {
    if (ruleMatches(rule, meta)) {
      if (rule.destination === "file") {
        if (!rule.path) {
          log("sessions", `file destination rule missing path — falling through`);
          continue;
        }
        return { destination: "file", path: rule.path };
      }
      return {
        destination: "agent",
        session: sanitizeSessionName(expandTemplate(rule.session ?? fallback, meta)),
        interrupt: rule.interrupt ?? true,
        batch: rule.batch,
      };
    }
  }

  return { destination: "agent", session: fallback, interrupt: true };
}

function sanitizeSessionName(name: string): string {
  return name.replace(/\0/g, "").replace(/[/\\]/g, "-").replace(/\.\./g, "-").slice(0, 100);
}
