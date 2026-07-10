// Maps the web UI's unified "thinking level" slider onto each template's own
// config.json shape, and back. Claude (Agent SDK) uses `effort` + `thinking`;
// codex uses `reasoningEffort`; pi uses `thinkingLevel` directly.

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

type ActiveLevel = Exclude<ThinkingLevel, "off">;

// The Agent SDK's `effort` has no "minimal"; fold it into "low".
const CLAUDE_EFFORT: Record<ActiveLevel, string> = {
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
};

const CODEX_EFFORT: Record<ActiveLevel, string> = {
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
};

/**
 * Write a unified thinking level into a template's config.json shape, in place.
 * For claude, "off" disables thinking and any other level sets an effort while
 * leaving `thinking` unset so the template's summarized-display default applies.
 */
export function applyThinkingLevel(
  config: Record<string, unknown>,
  template: string,
  level: ThinkingLevel,
): void {
  if (template === "claude") {
    if (level === "off") {
      config.thinking = { type: "disabled" };
      delete config.effort;
    } else {
      config.effort = CLAUDE_EFFORT[level];
      delete config.thinking;
    }
  } else if (template === "codex") {
    // Codex always reasons; "off" just drops the override (defaults to medium).
    if (level === "off") delete config.reasoningEffort;
    else config.reasoningEffort = CODEX_EFFORT[level];
  } else {
    // Pi consumes the unified level directly.
    config.thinkingLevel = level;
  }
}

/** Derive the unified thinking level from a template's config.json shape (for the UI). */
export function deriveThinkingLevel(config: Record<string, unknown>): ThinkingLevel | null {
  if (config.thinkingLevel) return config.thinkingLevel as ThinkingLevel; // pi
  if (config.reasoningEffort) return config.reasoningEffort as ThinkingLevel; // codex
  // Claude: derive from the Agent SDK's thinking/effort.
  const thinking = config.thinking as { type?: string } | undefined;
  if (thinking?.type === "disabled") return "off";
  const effort = config.effort as string | undefined;
  if (effort) return (effort === "max" ? "xhigh" : effort) as ThinkingLevel;
  return null;
}
