import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve } from "path";
import { randomUUID } from "crypto";
import { homedir } from "os";

interface OpenClawEvent {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
  message?: {
    role: string;
    content: unknown[];
    [key: string]: unknown;
  };
}

interface SdkEvent {
  type: "user" | "assistant";
  uuid: string;
  parentUuid: string | null;
  sessionId: string;
  timestamp: string;
  cwd: string;
  version: string;
  gitBranch: string;
  isSidechain: boolean;
  userType: string;
  message: {
    role: string;
    content: unknown[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/** Convert an OpenClaw session JSONL to Claude Agent SDK format and install it. */
export function convertSession(opts: {
  sessionPath: string;
  projectDir: string;
}): string {
  const lines = readFileSync(opts.sessionPath, "utf-8").trim().split("\n");
  const sessionId = randomUUID();
  const idMap = new Map<string, string>(); // OpenClaw id → SDK uuid

  // First pass: filter to message events only
  const messages: OpenClawEvent[] = [];
  for (const line of lines) {
    const event: OpenClawEvent = JSON.parse(line);
    if (event.type === "message" && event.message) {
      messages.push(event);
    }
  }

  // Second pass: convert, batching consecutive toolResults into single user messages
  const sdkEvents: string[] = [];
  let lastSdkUuid: string | null = null;

  for (let i = 0; i < messages.length; i++) {
    const event = messages[i];
    const msg = event.message!;

    if (msg.role === "user") {
      const uuid = randomUUID();
      idMap.set(event.id, uuid);
      const parentUuid = event.parentId
        ? (idMap.get(event.parentId) ?? null)
        : null;

      const sdkEvent: SdkEvent = {
        uuid,
        parentUuid,
        sessionId,
        timestamp: event.timestamp,
        cwd: opts.projectDir,
        version: "0.1.0",
        gitBranch: "main",
        isSidechain: false,
        userType: "external",
        type: "user",
        message: {
          role: "user",
          content: msg.content as unknown[],
        },
      };
      sdkEvents.push(JSON.stringify(sdkEvent));
      lastSdkUuid = uuid;
    } else if (msg.role === "assistant") {
      const content = convertAssistantContent(
        msg.content as Record<string, unknown>[],
      );
      if (content.length === 0) continue;

      const uuid = randomUUID();
      idMap.set(event.id, uuid);
      const parentUuid = event.parentId
        ? (idMap.get(event.parentId) ?? null)
        : null;

      const sdkEvent: SdkEvent = {
        uuid,
        parentUuid,
        sessionId,
        timestamp: event.timestamp,
        cwd: opts.projectDir,
        version: "0.1.0",
        gitBranch: "main",
        isSidechain: false,
        userType: "external",
        type: "assistant",
        message: {
          ...msg,
          role: "assistant",
          content,
        },
      };
      sdkEvents.push(JSON.stringify(sdkEvent));
      lastSdkUuid = uuid;
    } else if (msg.role === "toolResult") {
      // Collect all consecutive toolResult messages into one user message
      const toolResults: unknown[] = [];
      let lastToolResultId = event.id;
      let lastTimestamp = event.timestamp;

      let j = i;
      while (j < messages.length && messages[j].message!.role === "toolResult") {
        const tr = messages[j];
        const trMsg = tr.message!;
        lastToolResultId = tr.id;
        lastTimestamp = tr.timestamp;

        toolResults.push({
          type: "tool_result",
          tool_use_id: trMsg.toolCallId as string,
          content: trMsg.content,
          ...(trMsg.isError ? { is_error: true } : {}),
        });
        j++;
      }

      // Skip past the batched tool results (minus 1 since the for loop increments)
      i = j - 1;

      const uuid = randomUUID();
      idMap.set(lastToolResultId, uuid);
      // Point to the parent assistant message
      const parentUuid = event.parentId
        ? (idMap.get(event.parentId) ?? null)
        : lastSdkUuid;

      const sdkEvent: SdkEvent = {
        uuid,
        parentUuid,
        sessionId,
        timestamp: lastTimestamp,
        cwd: opts.projectDir,
        version: "0.1.0",
        gitBranch: "main",
        isSidechain: false,
        userType: "external",
        type: "user",
        message: {
          role: "user",
          content: toolResults,
        },
      };
      sdkEvents.push(JSON.stringify(sdkEvent));
      lastSdkUuid = uuid;
    }
  }

  // Write to SDK storage location
  const projectId = opts.projectDir.replace(/\//g, "-");
  const sdkDir = resolve(homedir(), ".claude", "projects", projectId);
  mkdirSync(sdkDir, { recursive: true });

  const sdkPath = resolve(sdkDir, `${sessionId}.jsonl`);
  writeFileSync(sdkPath, sdkEvents.join("\n") + "\n");

  console.log(`Converted ${sdkEvents.length} messages → ${sdkPath}`);
  return sessionId;
}

function convertAssistantContent(
  content: Record<string, unknown>[],
): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];

  for (const block of content) {
    if (block.type === "thinking") {
      // Strip thinking blocks — signatures won't validate cross-session
      continue;
    } else if (block.type === "toolCall") {
      // Convert toolCall → tool_use
      result.push({
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: block.arguments ?? block.input ?? {},
      });
    } else {
      // text and other blocks pass through
      result.push(block);
    }
  }

  return result;
}
