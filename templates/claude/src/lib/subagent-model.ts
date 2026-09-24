import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";

/**
 * The model a subagent runs on when the mind's config doesn't choose one — for
 * config-defined subagents and, via CLAUDE_CODE_SUBAGENT_MODEL and
 * createBuiltinSubagentModelHook, the SDK's built-in ones.
 *
 * Sonnet for a mind on an Opus- or Fable-class model, because subagents inheriting those
 * were a third of one mind's real spend. Everything else — Sonnet, Haiku, anything
 * unrecognised or non-Claude — inherits: a default must never raise a mind's cost, switch
 * it to a family it didn't choose, or name a model its backend may not serve.
 */
export function defaultSubagentModel(mindModel: string | undefined): string {
  return mindModel && /opus|fable/i.test(mindModel) ? "sonnet" : "inherit";
}

/**
 * The CLI's built-in agents defined with `model: "inherit"` (bundled CLI 2.1.281). The CLI
 * resolves "inherit" to the parent's model before it reads CLAUDE_CODE_SUBAGENT_MODEL, so
 * the env var never reaches these. Re-check this list when the SDK is bumped.
 */
const BUILTIN_INHERIT_AGENTS = new Set(["Explore", "Plan"]);

/** Whether a markdown agent under `agentsDir` (any depth) declares `name: <name>`. */
function definesAgent(agentsDir: string, name: string): boolean {
  let files: string[];
  try {
    files = readdirSync(agentsDir, { recursive: true, encoding: "utf-8" });
  } catch {
    return false;
  }
  const declares = new RegExp(`^name:\\s*["']?${name}["']?\\s*$`, "m");
  return files.some((file) => {
    if (!file.endsWith(".md")) return false;
    try {
      return declares.test(readFileSync(join(agentsDir, file), "utf-8"));
    } catch {
      return false;
    }
  });
}

/**
 * A PreToolUse hook on the Agent tool that fills in `model` for a call to one of the
 * built-in inherit agents — the per-call model outranks the definition's "inherit", and
 * the agent keeps its own prompt and tools. A call that names a model keeps it, and a
 * mind's own agent of the same name, which shadows the built-in — from its config or a
 * markdown file in `agentsDir` — is left alone.
 */
export function createBuiltinSubagentModelHook(
  model: string,
  configAgentNames: string[],
  agentsDir: string,
): HookCallback {
  const configured = new Set(configAgentNames);
  return async (input) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const toolInput = input.tool_input as Record<string, unknown>;
    const type = toolInput?.subagent_type;
    if (typeof type !== "string" || !BUILTIN_INHERIT_AGENTS.has(type)) return {};
    if (toolInput.model !== undefined) return {};
    if (configured.has(type) || definesAgent(agentsDir, type)) return {};
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        updatedInput: { ...toolInput, model },
      },
    };
  };
}
