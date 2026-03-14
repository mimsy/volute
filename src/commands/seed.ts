import { parseArgs } from "../lib/parse-args.js";
import { promptLine } from "../lib/prompt.js";

type ModelInfo = {
  id: string;
  name: string;
  provider: string;
  contextWindow?: number;
  enabled: boolean;
};

async function chooseModel(
  daemonFetch: (path: string, options?: RequestInit) => Promise<Response>,
): Promise<string | undefined> {
  const res = await daemonFetch("/api/system/ai/models");
  if (!res.ok) return undefined;

  const models = (await res.json()) as ModelInfo[];
  const enabled = models.filter((m) => m.enabled);
  if (enabled.length === 0) return undefined;

  console.log("\nAvailable models:");
  for (let i = 0; i < enabled.length; i++) {
    console.log(`  ${i + 1}) ${enabled[i].name} (${enabled[i].provider})`);
  }

  const answer = await promptLine(`\nChoose a model [1-${enabled.length}]: `);
  const idx = parseInt(answer, 10) - 1;
  if (idx < 0 || idx >= enabled.length || Number.isNaN(idx)) {
    console.error("Invalid selection");
    process.exit(1);
  }

  const chosen = enabled[idx];
  return `${chosen.provider}:${chosen.id}`;
}

export async function run(args: string[]) {
  const { positional, flags } = parseArgs(args, {
    template: { type: "string" },
    model: { type: "string" },
    description: { type: "string" },
    skills: { type: "string" },
  });

  const name = positional[0];
  if (!name) {
    console.error(
      "Usage: volute mind seed <name> [--template <name>] [--model <model>] [--description <text>] [--skills <list|none>]",
    );
    process.exit(1);
  }

  const template = flags.template ?? "claude";
  const skills = flags.skills === "none" ? [] : flags.skills ? flags.skills.split(",") : undefined;

  const { daemonFetch } = await import("../lib/daemon-client.js");
  const { getClient, urlOf } = await import("../lib/api-client.js");
  const client = getClient();

  // For pi template, prompt for model selection if not specified
  let model = flags.model;
  if (template === "pi" && !model) {
    model = await chooseModel(daemonFetch);
    if (!model) {
      console.error("No AI models configured. Set up providers in the web dashboard first.");
      process.exit(1);
    }
  }

  // Create mind as seed
  const createRes = await daemonFetch(urlOf(client.api.minds.$url()), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      template,
      stage: "seed",
      description: flags.description,
      model,
      skills,
    }),
  });

  const createData = (await createRes.json()) as {
    ok?: boolean;
    error?: string;
    name?: string;
    port?: number;
  };

  if (!createRes.ok) {
    console.error(createData.error ?? "Failed to create mind");
    process.exit(1);
  }

  // Start the mind
  const startRes = await daemonFetch(
    urlOf(client.api.minds[":name"].start.$url({ param: { name } })),
    { method: "POST" },
  );

  if (!startRes.ok) {
    const startData = (await startRes.json()) as { error?: string };
    console.error(startData.error ?? "Failed to start mind");
    process.exit(1);
  }

  // Send initial orientation message
  const initialMessage =
    "You've just been created. A human planted you as a seed. Start a conversation with them — introduce yourself, ask questions, and begin exploring who you want to be.";
  await daemonFetch(urlOf(client.api.minds[":name"].message.$url({ param: { name } })), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content: [{ type: "text", text: initialMessage }],
      channel: "system",
      sender: "system",
    }),
  });

  console.log(`\nSeeded mind: ${name} (port ${createData.port})`);
  console.log(`\nTalk to your new mind:`);
  console.log(`  volute chat send @${name} "hello"`);
}
