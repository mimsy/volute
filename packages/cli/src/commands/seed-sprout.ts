import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { mindDir } from "@volute/daemon/lib/mind/registry.js";
import { evaluateSeedChecklist } from "@volute/daemon/lib/mind/seed-readiness.js";
import { getStandardSkillsWithExtensions } from "@volute/daemon/lib/skills.js";
import { command } from "../lib/command.js";
import { daemonFetch } from "../lib/daemon-client.js";

const cmd = command({
  name: "volute seed sprout",
  description: "Complete orientation and become a full mind (run by the seed itself)",
  flags: {},
  run: async () => {
    const mindName = process.env.VOLUTE_MIND;
    if (!mindName) {
      console.error("volute seed sprout must be run by a mind (VOLUTE_MIND not set)");
      process.exit(1);
    }

    const mindRes = await daemonFetch(`/api/v1/minds/${encodeURIComponent(mindName)}`);
    if (!mindRes.ok) {
      console.error(`Mind "${mindName}" not found`);
      process.exit(1);
    }
    const mind = (await mindRes.json()) as { stage?: string };

    if (mind.stage !== "seed") {
      console.error(`${mindName} is not a seed — already at stage "${mind.stage}"`);
      process.exit(1);
    }

    const dir = mindDir(mindName);

    // Gate on the same checklist the spirit's seed-check and the orientation
    // skill describe — evaluated from one shared source so they can't drift.
    const checklist = evaluateSeedChecklist(dir);
    if (!checklist.soulWritten) {
      console.error(
        "Your SOUL.md is still the orientation template (or unwritten). Write your own identity first.",
      );
      process.exit(1);
    }
    if (!checklist.memoryWritten) {
      console.error(
        "Your MEMORY.md is still empty or the starter placeholder. Write your own memory first.",
      );
      process.exit(1);
    }
    if (!checklist.displayNameSet) {
      console.error(
        'Set your display name before sprouting: volute mind profile --display-name "Your Name"',
      );
      process.exit(1);
    }
    if (checklist.imagegenEnabled && !checklist.avatarSet) {
      console.error(
        "Generate an avatar before sprouting. Use `imagegen generate` to create one, then `volute mind profile --avatar <path>` to set it.",
      );
      process.exit(1);
    }

    // Set up API client for typed URL helpers
    const { getClient, urlOf } = await import("../lib/api-client.js");
    const { mindSkillsDir } = await import("@volute/daemon/lib/skills.js");
    const client = getClient();

    // Install standard skills from shared pool via daemon, remove orientation
    const failedSkills: string[] = [];
    for (const skillId of getStandardSkillsWithExtensions()) {
      const skillDir = resolve(mindSkillsDir(dir), skillId);
      if (!existsSync(skillDir)) {
        const installRes = await daemonFetch(
          urlOf(client.api.v1.minds[":name"].skills.install.$url({ param: { name: mindName } })),
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ skillId }),
          },
        );
        if (!installRes.ok) {
          const data = await installRes
            .json()
            .catch(() => ({ error: `HTTP ${installRes.status}` }));
          console.error(
            `Failed to install skill ${skillId}: ${(data as { error?: string }).error}`,
          );
          failedSkills.push(skillId);
        }
      }
    }

    // Remove orientation skill via daemon
    const orientationDir = resolve(mindSkillsDir(dir), "orientation");
    if (existsSync(orientationDir)) {
      const delRes = await daemonFetch(
        urlOf(
          client.api.v1.minds[":name"].skills[":skill"].$url({
            param: { name: mindName, skill: "orientation" },
          }),
        ),
        { method: "DELETE" },
      );
      if (!delRes.ok) {
        const data = await delRes.json().catch(() => ({ error: `HTTP ${delRes.status}` }));
        console.error(
          `Failed to uninstall orientation skill: ${(data as { error?: string }).error}`,
        );
      }
    }

    if (failedSkills.length > 0) {
      console.error(`Warning: failed to install skills: ${failedSkills.join(", ")}`);
    }

    const sproutRes = await daemonFetch(
      urlOf(client.api.v1.minds[":name"].sprout.$url({ param: { name: mindName } })),
      { method: "POST" },
    );
    if (!sproutRes.ok) {
      const data = await sproutRes.json().catch(() => ({ error: `HTTP ${sproutRes.status}` }));
      console.error((data as { error?: string }).error ?? "Failed to update stage");
      process.exit(1);
    }

    // Restart with sprouted context
    const res = await daemonFetch(
      urlOf(client.api.v1.minds[":name"].restart.$url({ param: { name: mindName } })),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ context: { type: "sprouted" } }),
      },
    );

    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      console.error((data as { error?: string }).error ?? "Failed to restart after sprouting");
      process.exit(1);
    }

    console.log("Sprouted! You now have full mind capabilities.");
  },
});

export const run = cmd.execute;
