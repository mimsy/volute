import type { HookCallback, PreCompactHookInput } from "@anthropic-ai/claude-agent-sdk";
import { log } from "../logger.js";

/**
 * PreCompact hook: the backstop for SDK-initiated auto-compaction.
 *
 * The primary compaction path is volute's own token threshold, which rotates the
 * session in place. This hook covers the case where the SDK decides to auto-compact
 * before (or instead of) that threshold firing:
 *
 *   - First fire: run `onCompact` (schedule a rotation — mark the session to rotate
 *     at turn end) and BLOCK the SDK's native compaction, so the session rotates
 *     instead of being natively compacted.
 *   - Second fire: allow the SDK's native compaction as an emergency backstop —
 *     only reachable if rotation never happened (a hung turn, or rotation failed).
 *
 * `reset()` re-arms the first-fire behavior; the agent calls it after a successful
 * rotation so a later auto-compact blocks + rotates again instead of falling
 * straight through to native compaction.
 *
 * Manual `/compact` with custom instructions is always allowed through untouched.
 */
export function createPreCompactHook(onCompact: () => void) {
  let compactBlocked = false;

  const hook: HookCallback = async (input) => {
    const { trigger, custom_instructions } = input as PreCompactHookInput;

    // Manual compaction with custom instructions — allow through without the block.
    if (trigger === "manual" && custom_instructions) {
      log("mind", "allowing manual compaction with custom instructions");
      return {};
    }

    // Auto-compaction: first pass schedules a rotation and blocks; second pass
    // allows the native compaction as the emergency backstop.
    if (!compactBlocked) {
      log("mind", "blocking auto-compaction — marking session for rotation");
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
    log("mind", "allowing native compaction (rotation did not intervene)");
    return {};
  };

  /** Re-arm the first-fire block/rotate behavior (called after a rotation). */
  function reset() {
    compactBlocked = false;
  }

  return { hook, reset };
}
