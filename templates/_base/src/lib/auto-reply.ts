import { daemonSend } from "./daemon-client.js";
import { log } from "./logger.js";

export type MessageChannelInfo = { channel: string; autoReply: boolean };

export type AutoReplyTracker = {
  accumulate(text: string): void;
  flush(currentMessageId: string | undefined): void;
  reset(): void;
};

export function createAutoReplyTracker(
  messageChannels: Map<string, MessageChannelInfo>,
): AutoReplyTracker {
  let accumulator = "";

  function flush(currentMessageId: string | undefined) {
    const text = accumulator.trim();
    accumulator = "";
    if (!text) return;
    const info = currentMessageId ? messageChannels.get(currentMessageId) : undefined;
    if (info?.autoReply && info.channel) {
      daemonSend(info.channel, text).catch((err) => {
        log("agent", `auto-reply to ${info.channel} failed: ${err}`);
      });
    }
  }

  return {
    accumulate(text: string) {
      accumulator += text;
    },
    flush,
    reset() {
      accumulator = "";
    },
  };
}
