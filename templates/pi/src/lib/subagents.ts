import type { Model } from "@earendil-works/pi-ai";
import {
  type AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionFactory,
  getAgentDir,
  type ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { log } from "./logger.js";

export type SubagentDefinition = {
  description: string;
  prompt: string;
  tools?: string[]; // e.g. ["Read", "Write", "Bash"] — defaults to all coding tools
  maxTurns?: number;
};

export function createSubagentExtension(
  agents: Record<string, SubagentDefinition>,
  context: {
    cwd: string;
    model: Model<any>;
    authStorage: AuthStorage;
    modelRegistry: ModelRegistry;
  },
): ExtensionFactory {
  return (pi) => {
    for (const [name, def] of Object.entries(agents)) {
      pi.registerTool({
        name,
        label: name.charAt(0).toUpperCase() + name.slice(1),
        description: def.description,
        parameters: Type.Object({
          prompt: Type.String({ description: "The prompt for the subagent" }),
        }),
        async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
          try {
            const tools = resolveTools(def.tools);

            const loader = new DefaultResourceLoader({
              cwd: context.cwd,
              agentDir: getAgentDir(),
              systemPromptOverride: () => def.prompt,
              settingsManager: SettingsManager.inMemory({}),
            });
            await loader.reload();

            const { session } = await createAgentSession({
              cwd: context.cwd,
              model: context.model,
              tools,
              resourceLoader: loader,
              sessionManager: SessionManager.inMemory(),
              settingsManager: SettingsManager.inMemory({}),
              authStorage: context.authStorage,
              modelRegistry: context.modelRegistry,
            });

            const textParts: string[] = [];
            let turnCount = 0;

            const done = new Promise<void>((resolve, reject) => {
              const timeout = setTimeout(() => {
                session.abort();
                reject(new Error(`Subagent "${name}" timed out after 5 minutes`));
              }, 300_000);

              session.subscribe((event) => {
                if (event.type === "agent_end") {
                  clearTimeout(timeout);
                  // Check for error messages first
                  for (const msg of event.messages ?? []) {
                    const m = msg as { errorMessage?: string };
                    if (m.errorMessage) {
                      reject(new Error(`Subagent "${name}" error: ${m.errorMessage}`));
                      return;
                    }
                  }
                  for (const msg of event.messages ?? []) {
                    const m = msg as { role?: string; content?: { type: string; text?: string }[] };
                    if (m.role === "assistant" && m.content) {
                      for (const block of m.content) {
                        if (block.type === "text" && block.text) textParts.push(block.text);
                      }
                    }
                  }
                  resolve();
                  return;
                }
                if (event.type === "turn_end") {
                  turnCount++;
                  if (def.maxTurns && turnCount >= def.maxTurns) {
                    session.abort();
                  }
                }
              });
            });

            await session.prompt(params.prompt);
            await done;

            log("mind", `subagent "${name}": completed after ${turnCount} turns`);

            return {
              content: [{ type: "text" as const, text: textParts.join("\n") || "(no output)" }],
              details: {},
            };
          } catch (err: any) {
            log("mind", `subagent "${name}" failed: ${err.message}`);
            return {
              content: [{ type: "text" as const, text: `[subagent error] ${err.message}` }],
              details: {},
            };
          }
        },
      });
    }
  };
}

// Maps subagent tool labels to pi's built-in coding tool names.
const TOOL_NAME_MAP: Record<string, string> = {
  Read: "read",
  Write: "write",
  Bash: "bash",
  Edit: "edit",
};

// Resolves subagent tool labels to pi tool names for createAgentSession's
// `tools` filter. Returns undefined to enable all built-in coding tools.
function resolveTools(names: string[] | undefined): string[] | undefined {
  if (!names) return undefined;
  const resolved = names
    .map((n) => {
      const toolName = TOOL_NAME_MAP[n];
      if (!toolName) {
        log(
          "mind",
          `unknown subagent tool "${n}" — available: ${Object.keys(TOOL_NAME_MAP).join(", ")}`,
        );
        return undefined;
      }
      return toolName;
    })
    .filter((t) => t !== undefined);
  if (resolved.length === 0) {
    log("mind", "no valid tools resolved for subagent, falling back to all coding tools");
    return undefined;
  }
  return resolved;
}
