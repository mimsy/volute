import { parseArgs } from "../lib/parse-args.js";

export async function run(args: string[]) {
  const { positional, flags } = parseArgs(args, {
    template: { type: "string" },
    model: { type: "string" },
    description: { type: "string" },
  });

  const name = positional[0];
  if (!name) {
    console.error(
      "Usage: volute seed <name> [--template <name>] [--model <model>] [--description <text>]",
    );
    process.exit(1);
  }

  const template = flags.template ?? "claude";
  const { daemonFetch } = await import("../lib/daemon-client.js");
  const { getClient, urlOf } = await import("../lib/api-client.js");
  const client = getClient();

  // Create mind as seed
  const createRes = await daemonFetch(urlOf(client.api.minds.$url()), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      template,
      stage: "seed",
      description: flags.description,
      model: flags.model,
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
  console.log(`  volute send @${name} "hello"`);
}
