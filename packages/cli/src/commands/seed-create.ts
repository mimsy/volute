import { command } from "../lib/command.js";
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
  if (!res.ok) {
    console.error(`Failed to fetch AI models (HTTP ${res.status}). Is the daemon running?`);
    process.exit(1);
  }

  const models = (await res.json()) as ModelInfo[];
  const enabled = models.filter((m) => m.enabled);
  if (enabled.length === 0) return undefined;

  console.log("\nAvailable models:");
  for (let i = 0; i < enabled.length; i++) {
    console.log(`  ${i + 1}) ${enabled[i].name} (${enabled[i].provider})`);
  }

  const answer = await promptLine(`\nChoose a model [1-${enabled.length}]: `);
  const idx = parseInt(answer, 10) - 1;
  if (Number.isNaN(idx) || idx < 0 || idx >= enabled.length) {
    console.error("Invalid selection");
    process.exit(1);
  }

  const chosen = enabled[idx];
  return `${chosen.provider}:${chosen.id}`;
}

const cmd = command({
  name: "volute seed create",
  description: "Plant a new seed mind",
  args: [{ name: "name", required: true, description: "Name for the seed mind" }],
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
    let model = flags.model;
    let template = flags.template;
    if (!template) {
      const { resolveTemplate } = await import("@volute/daemon/lib/ai-service.js");
      template = resolveTemplate(model);
    }

    // For non-claude templates, resolve model if not specified
    if (template !== "claude" && !model) {
      // Non-interactive (e.g. mind running a command): use the spirit model as default
      if (process.env.VOLUTE_MIND || !process.stdin.isTTY) {
        const { getSpiritModel } = await import("@volute/daemon/lib/mind/spirit.js");
        const { qualifyModelId } = await import("@volute/daemon/lib/ai-service.js");
        const spiritModel = getSpiritModel();
        if (spiritModel) {
          model = template === "pi" ? qualifyModelId(spiritModel) : spiritModel;
        }
      }
      // Interactive: prompt for model selection
      if (!model) {
        model = await chooseModel(daemonFetch);
        if (!model) {
          console.error("No AI models configured. Set up providers in the web dashboard first.");
          process.exit(1);
        }
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
        createdBy,
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

    console.log(`\nSeeded mind: ${name} (port ${createData.port})`);
    console.log(`\nTalk to your new mind:`);
    console.log(`  volute chat send @${name} "hello"`);
  },
});

export const run = cmd.execute;
