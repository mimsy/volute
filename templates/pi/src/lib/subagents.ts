import type { Model } from "@mariozechner/pi-ai";
import {
  type AuthStorage,
  bashTool,
  codingTools,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionFactory,
  editTool,
  type ModelRegistry,
  readTool,
  SessionManager,
  SettingsManager,
  writeTool,
} from "@mariozechner/pi-coding-agent";
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

              session.subscribe((event: any) => {
                if (event.type === "agent_error") {
                  clearTimeout(timeout);
                  reject(
                    new Error(`Subagent "${name}" error: ${event.error?.message ?? "unknown"}`),
                  );
                  return;
                }
                if (event.type === "turn_end") {
                  turnCount++;
                  if (def.maxTurns && turnCount >= def.maxTurns) {
                    session.abort();
                  }
                }
                if (event.type === "agent_end") {
                  clearTimeout(timeout);
                  for (const msg of event.messages ?? []) {
                    if (msg.role === "assistant" && msg.content) {
                      for (const block of msg.content) {
                        if (block.type === "text") textParts.push(block.text);
                      }
                    }
                  }
                  resolve();
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

const TOOL_MAP: Record<string, any> = {
  Read: readTool,
  Write: writeTool,
  Bash: bashTool,
  Edit: editTool,
};

function resolveTools(names: string[] | undefined) {
  if (!names) return codingTools;
  const resolved = names
    .map((n) => {
      if (!TOOL_MAP[n]) {
        log(
          "mind",
          `unknown subagent tool "${n}" — available: ${Object.keys(TOOL_MAP).join(", ")}`,
        );
      }
      return TOOL_MAP[n];
    })
    .filter(Boolean);
  if (resolved.length === 0) {
    log("mind", "no valid tools resolved for subagent, falling back to all coding tools");
    return codingTools;
  }
  return resolved;
}
