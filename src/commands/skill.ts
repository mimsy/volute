import { getClient, urlOf } from "../lib/api-client.js";
import { daemonFetch } from "../lib/daemon-client.js";
import { parseArgs } from "../lib/parse-args.js";
import { resolveMindName } from "../lib/resolve-mind-name.js";

export async function run(args: string[]) {
  const subcommand = args[0];

  switch (subcommand) {
    case "list":
      await listSkills(args.slice(1));
      break;
    case "info":
      await infoSkill(args.slice(1));
      break;
    case "install":
      await installSkill(args.slice(1));
      break;
    case "update":
      await updateSkill(args.slice(1));
      break;
    case "publish":
      await publishSkill(args.slice(1));
      break;
    case "remove":
      await removeSkill(args.slice(1));
      break;
    case "uninstall":
      await uninstallSkill(args.slice(1));
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
  volute skill list                    List shared skills available to install
  volute skill list --mind <name>      List installed skills for a mind
  volute skill info <name>             Show details of a shared skill
  volute skill install <name> --mind   Install a shared skill into a mind
  volute skill update <name> --mind    Update an installed skill (3-way merge)
  volute skill update --all --mind     Update all installed skills
  volute skill publish <name> --mind   Publish a mind's skill to the shared repository
  volute skill remove <name>           Remove a shared skill
  volute skill uninstall <name> --mind Uninstall a skill from a mind`);
}

async function listSkills(args: string[]) {
  const { flags } = parseArgs(args, { mind: { type: "string" } });

  if (flags.mind || process.env.VOLUTE_MIND) {
    const mindName = resolveMindName(flags);
    const client = getClient();
    const url = urlOf(client.api.minds[":name"].skills.$url({ param: { name: mindName } }));
    const res = await daemonFetch(url);
    if (!res.ok) {
      const body = (await res.json().catch(() => ({ error: "Unknown error" }))) as {
        error: string;
      };
      console.error(`Error: ${body.error}`);
      process.exit(1);
    }

    const skills = (await res.json()) as Array<{
      id: string;
      name: string;
      upstream: { source: string; version: number } | null;
      updateAvailable: boolean;
    }>;

    if (skills.length === 0) {
      console.log("No skills installed.");
      return;
    }

    console.log(`Skills for ${mindName}:\n`);
    for (const s of skills) {
      const update = s.updateAvailable ? " (update available)" : "";
      const source = s.upstream ? ` [shared:${s.upstream.source} v${s.upstream.version}]` : "";
      console.log(`  ${s.id} — ${s.name}${source}${update}`);
    }
  } else {
    const client = getClient();
    const url = urlOf(client.api.skills.$url());
    const res = await daemonFetch(url);
    if (!res.ok) {
      const body = (await res.json().catch(() => ({ error: "Unknown error" }))) as {
        error: string;
      };
      console.error(`Error: ${body.error}`);
      process.exit(1);
    }

    const skills = (await res.json()) as Array<{
      id: string;
      name: string;
      description: string;
      author: string;
      version: number;
    }>;

    if (skills.length === 0) {
      console.log("No shared skills available.");
      return;
    }

    console.log("Shared skills:\n");
    for (const s of skills) {
      console.log(`  ${s.id} — ${s.name} (v${s.version}, by ${s.author})`);
      if (s.description) console.log(`    ${s.description}`);
    }
  }
}

async function infoSkill(args: string[]) {
  const { positional } = parseArgs(args, {});
  const id = positional[0];
  if (!id) {
    console.error("Usage: volute skill info <name>");
    process.exit(1);
  }

  const client = getClient();
  const url = urlOf(client.api.skills[":id"].$url({ param: { id } }));
  const res = await daemonFetch(url);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({ error: "Unknown error" }))) as {
      error: string;
    };
    console.error(`Error: ${body.error}`);
    process.exit(1);
  }

  const skill = (await res.json()) as {
    id: string;
    name: string;
    description: string;
    author: string;
    version: number;
    files: string[];
    created_at: string;
    updated_at: string;
  };

  console.log(`${skill.name} (${skill.id})`);
  console.log(`  Version: ${skill.version}`);
  console.log(`  Author: ${skill.author}`);
  if (skill.description) console.log(`  Description: ${skill.description}`);
  console.log(`  Files: ${skill.files.join(", ")}`);
}

async function installSkill(args: string[]) {
  const { positional, flags } = parseArgs(args, { mind: { type: "string" } });
  const mindName = resolveMindName(flags);
  const skillId = positional[0];

  if (!skillId) {
    console.error("Usage: volute skill install <name> [--mind <name>]");
    process.exit(1);
  }

  const client = getClient();
  const url = urlOf(client.api.minds[":name"].skills.install.$url({ param: { name: mindName } }));
  const res = await daemonFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ skillId }),
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => ({ error: "Unknown error" }))) as {
      error: string;
    };
    console.error(`Error: ${body.error}`);
    process.exit(1);
  }

  console.log(`Installed skill "${skillId}" into ${mindName}.`);
}

async function updateSkill(args: string[]) {
  const { positional, flags } = parseArgs(args, {
    mind: { type: "string" },
    all: { type: "boolean" },
  });
  const mindName = resolveMindName(flags);

  if (flags.all) {
    // Update all skills
    const client = getClient();
    const listUrl = urlOf(client.api.minds[":name"].skills.$url({ param: { name: mindName } }));
    const listRes = await daemonFetch(listUrl);
    if (!listRes.ok) {
      const body = (await listRes.json().catch(() => ({ error: "Unknown error" }))) as {
        error: string;
      };
      console.error(`Error: ${body.error}`);
      process.exit(1);
    }

    const skills = (await listRes.json()) as Array<{
      id: string;
      updateAvailable: boolean;
      upstream: { source: string } | null;
    }>;
    const updatable = skills.filter((s) => s.updateAvailable && s.upstream);

    if (updatable.length === 0) {
      console.log("All skills are up to date.");
      return;
    }

    for (const s of updatable) {
      await doUpdate(mindName, s.id);
    }
    return;
  }

  const skillId = positional[0];
  if (!skillId) {
    console.error("Usage: volute skill update <name> [--mind <name>] [--all]");
    process.exit(1);
  }

  await doUpdate(mindName, skillId);
}

async function doUpdate(mindName: string, skillId: string) {
  const client = getClient();
  const url = urlOf(client.api.minds[":name"].skills.update.$url({ param: { name: mindName } }));
  const res = await daemonFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ skillId }),
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => ({ error: "Unknown error" }))) as {
      error: string;
    };
    console.error(`Error updating ${skillId}: ${body.error}`);
    process.exit(1);
  }

  const result = (await res.json()) as {
    status: "updated" | "conflict" | "up-to-date";
    conflictFiles?: string[];
  };

  switch (result.status) {
    case "up-to-date":
      console.log(`${skillId}: already up to date.`);
      break;
    case "updated":
      console.log(`${skillId}: updated successfully.`);
      break;
    case "conflict":
      console.log(`${skillId}: updated with conflicts in:`);
      for (const f of result.conflictFiles ?? []) {
        console.log(`  ${f}`);
      }
      console.log("Resolve conflicts and commit manually.");
      break;
  }
}

async function publishSkill(args: string[]) {
  const { positional, flags } = parseArgs(args, { mind: { type: "string" } });
  const mindName = resolveMindName(flags);
  const skillId = positional[0];

  if (!skillId) {
    console.error("Usage: volute skill publish <name> [--mind <name>]");
    process.exit(1);
  }

  const client = getClient();
  const url = urlOf(client.api.minds[":name"].skills.publish.$url({ param: { name: mindName } }));
  const res = await daemonFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ skillId }),
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => ({ error: "Unknown error" }))) as {
      error: string;
    };
    console.error(`Error: ${body.error}`);
    process.exit(1);
  }

  const skill = (await res.json()) as { id: string; version: number };
  console.log(`Published skill "${skillId}" (v${skill.version}).`);
}

async function removeSkill(args: string[]) {
  const { positional } = parseArgs(args, {});
  const id = positional[0];

  if (!id) {
    console.error("Usage: volute skill remove <name>");
    process.exit(1);
  }

  const client = getClient();
  const url = urlOf(client.api.skills[":id"].$url({ param: { id } }));
  const res = await daemonFetch(url, { method: "DELETE" });

  if (!res.ok) {
    const body = (await res.json().catch(() => ({ error: "Unknown error" }))) as {
      error: string;
    };
    console.error(`Error: ${body.error}`);
    process.exit(1);
  }

  console.log(`Removed shared skill "${id}".`);
}

async function uninstallSkill(args: string[]) {
  const { positional, flags } = parseArgs(args, { mind: { type: "string" } });
  const mindName = resolveMindName(flags);
  const skillId = positional[0];

  if (!skillId) {
    console.error("Usage: volute skill uninstall <name> [--mind <name>]");
    process.exit(1);
  }

  const client = getClient();
  const url = urlOf(
    client.api.minds[":name"].skills[":skill"].$url({
      param: { name: mindName, skill: skillId },
    }),
  );
  const res = await daemonFetch(url, { method: "DELETE" });

  if (!res.ok) {
    const body = (await res.json().catch(() => ({ error: "Unknown error" }))) as {
      error: string;
    };
    console.error(`Error: ${body.error}`);
    process.exit(1);
  }

  console.log(`Uninstalled skill "${skillId}" from ${mindName}.`);
}
