import { resolveModel } from "../lib/choose-model.js";
import { command } from "../lib/command.js";

const cmd = command({
  name: "volute mind create",
  description: "Create a new mind (see 'volute seed create' for the recommended path)",
  args: [{ name: "name", required: true, description: "Name for the new mind" }],
  flags: {
    template: { type: "string", description: "Template to use (claude, pi, codex)" },
    model: { type: "string", description: "AI model to use" },
    skills: {
      type: "string",
      description: "Skills to install (comma-separated, or 'none')",
    },
  },
  async run({ args, flags }) {
    const name = args.name!;
    let template = flags.template;
    if (!template) {
      const { resolveTemplate } = await import("@volute/daemon/lib/ai-service.js");
      template = await resolveTemplate(flags.model);
    }

    const skills =
      flags.skills === "none" ? [] : flags.skills ? flags.skills.split(",") : undefined;

    const { daemonFetch } = await import("../lib/daemon-client.js");
    const { getClient, urlOf } = await import("../lib/api-client.js");
    const client = getClient();

    // Never prompts. `mind create` is run by scripts, by cron, by `docker exec`, and
    // by the spirit on a host's behalf; a blocking question on any of those is a hang,
    // not a choice. `seed create` is where a host goes to be asked.
    const model = await resolveModel(template, flags.model);

    const res = await daemonFetch(urlOf(client.api.v1.minds.$url()), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, template, model: model.send, skills }),
    });

    const data = (await res.json()) as {
      ok?: boolean;
      error?: string;
      name?: string;
      port?: number;
      message?: string;
      warning?: string;
      credentialWarning?: string;
    };

    if (!res.ok) {
      console.error(data.error ?? "Failed to create mind");
      process.exit(1);
    }

    const created = data.name ?? name;
    console.log(`\n${data.message ?? `Created mind: ${created} (port ${data.port})`}`);
    // Say which model it woke up on. Silence here is the actual complaint in #1034:
    // a mind was born on something nobody named and nobody was told.
    console.log(`Model: ${model.describe}`);
    if (data.warning) console.warn(`\n⚠ ${data.warning}`);
    if (data.credentialWarning) console.warn(`\n⚠ ${data.credentialWarning}`);
    console.log(`\nStart it, then say hello:`);
    console.log(`  volute mind start ${created}`);
    console.log(`  volute chat send @${created} "hello"`);
    console.log(
      `\nTip: 'volute seed create' grows a mind that shapes its own identity — the recommended way to start.`,
    );
  },
});

export const run = cmd.execute;
