import type { HookCallback, PreCompactHookInput } from "@anthropic-ai/claude-agent-sdk";
import { log } from "../logger.js";

export function createPreCompactHook(onCompact: () => void) {
  let compactBlocked = false;

  const hook: HookCallback = async (input) => {
    const { trigger, custom_instructions } = input as PreCompactHookInput;

    // Our custom compaction (via /compact with instructions) — allow through without the two-pass block
    if (trigger === "manual" && custom_instructions) {
      log("mind", "allowing manual compaction with custom instructions");
      return {};
    }

    // Auto-compaction: two-pass block (first pass warns mind, second pass allows)
    if (!compactBlocked) {
      log("mind", "blocking compaction — asking mind to update daily log first");
      try {
        onCompact();
        compactBlocked = true;
      } catch (err) {
        log("mind", "onCompact callback failed, allowing compaction:", err);
        return {};
      }
      return { decision: "block" };
    }
    compactBlocked = false;
    log("mind", "allowing compaction");
    return {};
  };

  return { hook };
}
