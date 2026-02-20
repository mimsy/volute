import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";

export function createReplyInstructionsHook(messageChannels: Map<string, string>) {
  let fired = false;

  const hook: HookCallback = async () => {
    if (fired) return {};

    const channel = messageChannels.values().next().value;
    if (!channel) return {};

    fired = true;

    return {
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit" as const,
        additionalContext: `To reply to this message, use: volute send ${channel} "your message"`,
      },
    };
  };

  return { hook };
}
