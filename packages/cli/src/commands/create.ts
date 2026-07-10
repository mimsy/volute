import { command } from "../lib/command.js";

const cmd = command({
  name: "volute mind create",
  description: "Create a new mind (see 'volute seed create' for the recommended path)",
  args: [{ name: "name", required: true, description: "Name for the new mind" }],
  flags: {
    template: { type: "string", description: "Template to use (claude, pi, codex)" },
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
      template = await resolveTemplate();
    }

    const skills =
      flags.skills === "none" ? [] : flags.skills ? flags.skills.split(",") : undefined;

    const { daemonFetch } = await import("../lib/daemon-client.js");
    const { getClient, urlOf } = await import("../lib/api-client.js");
    const client = getClient();

    const res = await daemonFetch(urlOf(client.api.minds.$url()), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, template, skills }),
    });

    const data = (await res.json()) as {
      ok?: boolean;
      error?: string;
      name?: string;
      port?: number;
      message?: string;
    };

    if (!res.ok) {
      console.error(data.error ?? "Failed to create mind");
      process.exit(1);
    }

    const created = data.name ?? name;
    console.log(`\n${data.message ?? `Created mind: ${created} (port ${data.port})`}`);
    console.log(`\nStart it, then say hello:`);
    console.log(`  volute mind start ${created}`);
    console.log(`  volute chat send @${created} "hello"`);
    console.log(
      `\nTip: 'volute seed create' grows a mind that shapes its own identity — the recommended way to start.`,
    );
  },
});

export const run = cmd.execute;
