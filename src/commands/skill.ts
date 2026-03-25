import { getClient, urlOf } from "../lib/api-client.js";
import { command, subcommands } from "../lib/command.js";
import { daemonFetch } from "../lib/daemon-client.js";
import { isCompact } from "../lib/format-cli.js";
import { resolveMindName } from "../lib/resolve-mind-name.js";

const listSkillsCmd = command({
  name: "volute skill list",
  description: "List skills (shared pool or per-mind)",
  flags: {
    mind: { type: "string", description: "Mind name (shows installed skills for mind)" },
  },
  run: async ({ flags }) => {
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

      const compact = isCompact();
      console.log(`Skills for ${mindName}:${compact ? "" : "\n"}`);
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

      const compact = isCompact();
      console.log(`Shared skills:${compact ? "" : "\n"}`);
      for (const s of skills) {
        console.log(`  ${s.id} — ${s.name} (v${s.version}, by ${s.author})`);
        if (s.description && !compact) console.log(`    ${s.description}`);
      }
    }
  },
});

const infoSkillCmd = command({
  name: "volute skill info",
  description: "Show details of a shared skill",
  args: [{ name: "name", required: true, description: "Skill ID" }],
  flags: {},
  run: async ({ args }) => {
    const id = args.name!;

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
  },
});

const installSkillCmd = command({
  name: "volute skill install",
  description: "Install a shared skill into a mind",
  args: [{ name: "name", required: true, description: "Skill to install" }],
  flags: {
    mind: { type: "string", description: "Mind name" },
  },
  run: async ({ args, flags }) => {
    const mindName = resolveMindName(flags);
    const skillId = args.name!;

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

    const body = (await res.json().catch(() => ({}))) as {
      npmInstalled?: string[];
      installNotes?: string | null;
    };

    console.log(`Installed skill "${skillId}" into ${mindName}.`);
    if (body.npmInstalled?.length) {
      console.log(`Installed npm dependencies: ${body.npmInstalled.join(", ")}`);
    }
    if (body.installNotes) {
      console.log("");
      console.log(body.installNotes);
    }
  },
});

/** Returns true on success, false on failure (for --all loop) */
async function doUpdate(mindName: string, skillId: string): Promise<boolean> {
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
    return false;
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
  return true;
}

const updateSkillCmd = command({
  name: "volute skill update",
  description: "Update an installed skill from the shared pool (3-way merge)",
  args: [{ name: "name", description: "Skill to update" }],
  flags: {
    mind: { type: "string", description: "Mind name" },
    all: { type: "boolean", description: "Update all skills" },
  },
  run: async ({ args, flags }) => {
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

      let failures = 0;
      for (const s of updatable) {
        const ok = await doUpdate(mindName, s.id);
        if (!ok) failures++;
      }
      if (failures > 0) process.exit(1);
      return;
    }

    const skillId = args.name;
    if (!skillId) {
      console.error("Usage: volute skill update <name> [--mind <name>] [--all]");
      process.exit(1);
    }

    const ok = await doUpdate(mindName, skillId);
    if (!ok) process.exit(1);
  },
});

const publishSkillCmd = command({
  name: "volute skill publish",
  description: "Publish a mind's skill to the shared repository",
  args: [{ name: "name", required: true, description: "Skill to publish" }],
  flags: {
    mind: { type: "string", description: "Mind name" },
  },
  run: async ({ args, flags }) => {
    const mindName = resolveMindName(flags);
    const skillId = args.name!;

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
  },
});

const removeSkillCmd = command({
  name: "volute skill remove",
  description: "Remove a shared skill from the pool",
  args: [{ name: "name", required: true, description: "Shared skill to remove" }],
  flags: {},
  run: async ({ args }) => {
    const id = args.name!;

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
  },
});

const uninstallSkillCmd = command({
  name: "volute skill uninstall",
  description: "Uninstall a skill from a mind",
  args: [{ name: "name", required: true, description: "Skill to uninstall" }],
  flags: {
    mind: { type: "string", description: "Mind name" },
  },
  run: async ({ args, flags }) => {
    const mindName = resolveMindName(flags);
    const skillId = args.name!;

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
  },
});

const defaultsListCmd = command({
  name: "volute skill defaults list",
  description: "List default skills for new minds",
  flags: {},
  run: async () => {
    const res = await daemonFetch("/api/skills/defaults/list");
    if (!res.ok) {
      const body = (await res.json().catch(() => ({ error: "Unknown error" }))) as {
        error: string;
      };
      console.error(`Error: ${body.error}`);
      process.exit(1);
    }
    const { skills } = (await res.json()) as { skills: string[] };
    console.log("Default skills for new minds:\n");
    for (const s of skills) {
      console.log(`  ${s}`);
    }
  },
});

const defaultsAddCmd = command({
  name: "volute skill defaults add",
  description: "Add a skill to the defaults",
  args: [{ name: "name", required: true, description: "Skill to add" }],
  flags: {},
  run: async ({ args }) => {
    const skillId = args.name!;
    const res = await daemonFetch("/api/skills/defaults/list", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ skill: skillId }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({ error: "Unknown error" }))) as {
        error: string;
      };
      console.error(`Error: ${body.error}`);
      process.exit(1);
    }
    console.log(`Added "${skillId}" to default skills.`);
  },
});

const defaultsRemoveCmd = command({
  name: "volute skill defaults remove",
  description: "Remove a skill from the defaults",
  args: [{ name: "name", required: true, description: "Skill to remove" }],
  flags: {},
  run: async ({ args }) => {
    const skillId = args.name!;
    const res = await daemonFetch(`/api/skills/defaults/list/${encodeURIComponent(skillId)}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({ error: "Unknown error" }))) as {
        error: string;
      };
      console.error(`Error: ${body.error}`);
      process.exit(1);
    }
    console.log(`Removed "${skillId}" from default skills.`);
  },
});

const defaultsCmd = subcommands({
  name: "volute skill defaults",
  description: "Manage default skills for new minds",
  commands: {
    list: {
      description: "List default skills",
      run: defaultsListCmd.execute,
    },
    add: {
      description: "Add a skill to the defaults",
      run: defaultsAddCmd.execute,
    },
    remove: {
      description: "Remove a skill from the defaults",
      run: defaultsRemoveCmd.execute,
    },
  },
});

const cmd = subcommands({
  name: "volute skill",
  description: "Browse, install, and manage skills",
  commands: {
    list: {
      description: "List skills (shared or per-mind with --mind)",
      run: listSkillsCmd.execute,
    },
    info: {
      description: "Show details of a shared skill",
      run: infoSkillCmd.execute,
    },
    install: {
      description: "Install a shared skill into a mind",
      run: installSkillCmd.execute,
    },
    update: {
      description: "Update an installed skill (3-way merge)",
      run: updateSkillCmd.execute,
    },
    publish: {
      description: "Publish a mind's skill to the shared repository",
      run: publishSkillCmd.execute,
    },
    remove: {
      description: "Remove a shared skill",
      run: removeSkillCmd.execute,
    },
    uninstall: {
      description: "Uninstall a skill from a mind",
      run: uninstallSkillCmd.execute,
    },
    defaults: {
      description: "Manage default skills for new minds",
      run: defaultsCmd.execute,
    },
  },
  footer: "Use --mind <name> or VOLUTE_MIND to identify the mind.",
});

export const run = cmd.execute;
