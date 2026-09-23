import { chooseModel, resolveModel } from "../lib/choose-model.js";
import { command } from "../lib/command.js";

const cmd = command({
  name: "volute seed create",
  description: "Plant a new seed",
  args: [{ name: "name", required: true, description: "Name for the seed" }],
  flags: {
    template: { type: "string", description: "Template to use" },
    model: { type: "string", description: "AI model to use" },
    description: { type: "string", description: "Description of the seed" },
    skills: { type: "string", description: "Skills to install (comma-separated, or 'none')" },
    "created-by": { type: "string", description: "Username of creator" },
  },
  run: async ({ args, flags }) => {
    const name = args.name!;

    const skills =
      flags.skills === "none" ? [] : flags.skills ? flags.skills.split(",") : undefined;
    const createdBy = flags["created-by"];

    const { daemonFetch } = await import("../lib/daemon-client.js");
    const { getClient, urlOf } = await import("../lib/api-client.js");
    const client = getClient();

    // Auto-resolve template if not specified
    let template = flags.template;
    if (!template) {
      const { resolveTemplate } = await import("@volute/daemon/lib/ai-service.js");
      template = await resolveTemplate(flags.model);
    }

    const choice = await resolveModel(template, flags.model);
    let model = choice.send;
    // seed create is the one place a host comes to be asked, so it still offers the
    // picker — but only to someone who can answer. promptLine never resolves on a
    // stdin that delivers no newline, so asking a script or a mind is a hang.
    if (choice.mayAsk && !process.env.VOLUTE_MIND && process.stdin.isTTY) {
      model = await chooseModel(daemonFetch, template);
      if (!model) {
        console.error(
          `No enabled model runs on the ${template} template. Enable one in the web dashboard (Settings), or choose another template.`,
        );
        process.exit(1);
      }
    }

    // Create mind as seed
    const createRes = await daemonFetch(urlOf(client.api.v1.minds.$url()), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        template,
        stage: "seed",
        description: flags.description,
        model,
        skills,
        createdBy,
      }),
    });

    const createData = (await createRes.json()) as {
      ok?: boolean;
      error?: string;
      name?: string;
      port?: number;
      credentialWarning?: string;
    };

    if (!createRes.ok) {
      console.error(createData.error ?? "Failed to create mind");
      process.exit(1);
    }

    if (createData.credentialWarning) console.warn(`\n⚠ ${createData.credentialWarning}`);

    // Start the mind
    const startRes = await daemonFetch(
      urlOf(client.api.v1.minds[":name"].start.$url({ param: { name } })),
      { method: "POST" },
    );

    if (!startRes.ok) {
      const startData = (await startRes.json()) as { error?: string };
      console.error(startData.error ?? "Failed to start mind");
      process.exit(1);
    }

    console.log(`\nSeeded mind: ${name} (port ${createData.port})`);
    console.log(`\nTalk to your new mind:`);
    console.log(`  volute chat send @${name} "hello"`);
  },
});

export const run = cmd.execute;
