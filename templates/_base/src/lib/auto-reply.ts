import { spawn } from "node:child_process";
import { log } from "./logger.js";

export type MessageChannelInfo = { channel: string; autoReply: boolean };

export function autoSend(channel: string, text: string): void {
  const proc = spawn("volute", ["send", channel], {
    stdio: ["pipe", "ignore", "pipe"],
  });
  proc.stdin!.on("error", () => {});
  proc.stdin!.write(text);
  proc.stdin!.end();

  let stderr = "";
  proc.stderr!.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  proc.on("error", (err) => {
    log("agent", `auto-reply to ${channel} spawn failed: ${err}`);
  });
  proc.on("exit", (code) => {
    if (code !== 0) {
      log("agent", `auto-reply to ${channel} failed (exit ${code}): ${stderr.trim()}`);
    }
  });
}

export function flushAutoReply(
  accumulator: string,
  currentMessageId: string | undefined,
  messageChannels: Map<string, MessageChannelInfo>,
): string {
  const text = accumulator.trim();
  if (!text) return "";
  const info = currentMessageId ? messageChannels.get(currentMessageId) : undefined;
  if (info?.autoReply && info.channel) {
    autoSend(info.channel, text);
  }
  return "";
}
