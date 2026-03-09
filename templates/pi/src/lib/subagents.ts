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
              reject(new Error(`Subagent "${name}" timed out`));
            }, 300_000);

            session.subscribe((event: any) => {
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
  return names.map((n) => TOOL_MAP[n]).filter(Boolean);
}
