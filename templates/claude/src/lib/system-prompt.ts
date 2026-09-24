import { log } from "./logger.js";

export type SystemPromptSource = {
  /** The prompt most recently built — what the newest SDK stream was given. */
  current(): string;
  /**
   * Rebuild from disk for a new SDK stream. Called only when a stream starts (first
   * message, resume after an idle reap, rotation), so an identity edit loads at the next
   * session boundary instead of rewriting a live session's prompt — and its cache — mid-work.
   * An unreadable file keeps the last good prompt rather than failing the stream.
   */
  forNewStream(): string;
};

/** `load` runs once now; a failure here is a startup failure and propagates. */
export function createSystemPromptSource(load: () => string): SystemPromptSource {
  let current = load();
  return {
    current: () => current,
    forNewStream() {
      try {
        current = load();
      } catch (err) {
        log("mind", "failed to rebuild system prompt, keeping the last good one:", err);
      }
      return current;
    },
  };
}
