import { userInfo } from "node:os";
import { daemonFetch } from "../lib/daemon-client.js";
import { summarizeTool } from "../lib/format-tool.js";
import { parseArgs } from "../lib/parse-args.js";
import { resolveAgentName } from "../lib/resolve-agent-name.js";

export async function run(args: string[]) {
  const subcommand = args[0];

  switch (subcommand) {
    case "create":
      await createConversation(args.slice(1));
      break;
    case "list":
      await listConversations(args.slice(1));
      break;
    case "send":
      await sendToConversation(args.slice(1));
      break;
    case "--help":
    case "-h":
    case undefined:
      printUsage();
      break;
    default:
      printUsage();
      process.exit(1);
  }
}

function printUsage() {
  console.log(`Usage:
  volute conversation create --participants user1,agent1 [--title "..."] [--agent <name>]
  volute conversation list [--agent <name>]
  volute conversation send <id> "<message>" [--agent <name>]`);
}

async function createConversation(args: string[]) {
  const { flags } = parseArgs(args, {
    agent: { type: "string" },
    participants: { type: "string" },
    title: { type: "string" },
  });

  const agentName = resolveAgentName(flags);
  if (!flags.participants) {
    console.error("--participants is required (comma-separated usernames)");
    process.exit(1);
  }

  const participantNames = flags.participants.split(",").map((s) => s.trim());

  const res = await daemonFetch(`/api/agents/${encodeURIComponent(agentName)}/conversations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ participantNames, title: flags.title }),
  });

  if (!res.ok) {
    const data = (await res.json()) as { error?: string };
    console.error(data.error ?? `Failed to create conversation: ${res.status}`);
    process.exit(1);
  }

  const conv = (await res.json()) as { id: string; title: string | null };
  console.log(`Created conversation: ${conv.id}`);
  if (conv.title) console.log(`Title: ${conv.title}`);
}

async function listConversations(args: string[]) {
  const { flags } = parseArgs(args, {
    agent: { type: "string" },
  });

  const agentName = resolveAgentName(flags);

  const res = await daemonFetch(`/api/agents/${encodeURIComponent(agentName)}/conversations`);

  if (!res.ok) {
    const data = (await res.json()) as { error?: string };
    console.error(data.error ?? `Failed to list conversations: ${res.status}`);
    process.exit(1);
  }

  const convs = (await res.json()) as {
    id: string;
    title: string | null;
    updated_at: string;
  }[];

  if (convs.length === 0) {
    console.log("No conversations.");
    return;
  }

  for (const conv of convs) {
    const title = conv.title || "(untitled)";
    console.log(`${conv.id}  ${title}  ${conv.updated_at}`);
  }
}

async function sendToConversation(args: string[]) {
  const { positional, flags } = parseArgs(args, {
    agent: { type: "string" },
  });

  const conversationId = positional[0];
  const message = positional[1];
  if (!conversationId || !message) {
    console.error('Usage: volute conversation send <id> "<message>" [--agent <name>]');
    process.exit(1);
  }

  const agentName = resolveAgentName(flags);

  const res = await daemonFetch(`/api/agents/${encodeURIComponent(agentName)}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message,
      conversationId,
      sender: process.env.VOLUTE_AGENT || userInfo().username,
    }),
  });

  if (!res.ok) {
    const data = (await res.json()) as { error?: string };
    console.error(data.error ?? `Failed to send message: ${res.status}`);
    process.exit(1);
  }

  if (!res.body) {
    console.error("No response body");
    process.exit(1);
  }

  // Parse SSE stream
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data) continue;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(data);
      } catch {
        continue;
      }
      if (event.type === "text") {
        process.stdout.write(event.content as string);
      } else if (event.type === "tool_use") {
        process.stderr.write(`${summarizeTool(event.name as string, event.input)}\n`);
      }
      if (event.type === "done") {
        process.stdout.write("\n");
        return;
      }
    }
  }

  process.stdout.write("\n");
}
