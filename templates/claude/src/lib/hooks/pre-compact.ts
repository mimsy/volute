import type { HookCallback, PreCompactHookInput } from "@anthropic-ai/claude-agent-sdk";
import { log } from "../logger.js";

export function createPreCompactHook(onCompact: () => void) {
  let compactBlocked = false;

  const hook: HookCallback = async (input) => {
    const { trigger, custom_instructions } = input as PreCompactHookInput;

    // Manual compaction with custom instructions — allow through
    if (trigger === "manual" && custom_instructions) {
      log("mind", "allowing manual compaction with custom instructions");
      return {};
    }

    // Auto-compaction: two-pass block (first pass warns mind, second pass allows)
    if (!compactBlocked) {
      compactBlocked = true;
      log("mind", "blocking compaction — asking mind to update daily log first");
      onCompact();
      return { decision: "block" };
    }
    compactBlocked = false;
    log("mind", "allowing compaction");
    return {};
  };

  return { hook };
}
