import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { log } from "../logger.js";

export function createPreCompactHook(onCompact: () => void) {
  let compactBlocked = false;

  const hook: HookCallback = async () => {
    if (!compactBlocked) {
      compactBlocked = true;
      log("agent", "blocking compaction — asking agent to update daily log first");
      onCompact();
      return { decision: "block" };
    }
    compactBlocked = false;
    log("agent", "allowing compaction");
    return {};
  };

  return { hook };
}
