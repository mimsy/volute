import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { findMind, mindDir } from "@volute/shared/registry";
import { STANDARD_SKILLS } from "../lib/skills.js";

const ORIENTATION_MARKER = "You don't have a soul yet";

export async function run(_args: string[]) {
  const mindName = process.env.VOLUTE_MIND;
  if (!mindName) {
    console.error("volute mind sprout must be run by a mind (VOLUTE_MIND not set)");
    process.exit(1);
  }

  const entry = findMind(mindName);
  if (!entry) {
    console.error(`Unknown mind: ${mindName}`);
    process.exit(1);
  }

  if (entry.stage !== "seed") {
    console.error(`${mindName} is not a seed — already at stage "${entry.stage}"`);
    process.exit(1);
  }

  const dir = mindDir(mindName);
  const soulPath = resolve(dir, "home/SOUL.md");
  const memoryPath = resolve(dir, "home/MEMORY.md");

  // Validate SOUL.md
  if (!existsSync(soulPath)) {
    console.error("Write your SOUL.md before sprouting.");
    process.exit(1);
  }
  const soul = readFileSync(soulPath, "utf-8");
  if (soul.includes(ORIENTATION_MARKER)) {
    console.error(
      "Your SOUL.md still contains the orientation template. Write your own identity first.",
    );
    process.exit(1);
  }

  // Validate MEMORY.md
  if (!existsSync(memoryPath)) {
    console.error("Write your MEMORY.md before sprouting.");
    process.exit(1);
  }

  // Set up daemon client for API calls
  const { daemonFetch } = await import("../lib/daemon-client.js");
  const { getClient, urlOf } = await import("../lib/api-client.js");
  const client = getClient();

  // Install standard skills from shared pool via daemon, remove orientation
  const failedSkills: string[] = [];
  for (const skillId of STANDARD_SKILLS) {
    const skillDir = resolve(dir, "home", ".claude", "skills", skillId);
    if (!existsSync(skillDir)) {
      const installRes = await daemonFetch(
        urlOf(client.api.minds[":name"].skills.install.$url({ param: { name: mindName } })),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ skillId }),
        },
      );
      if (!installRes.ok) {
        const data = await installRes.json().catch(() => ({ error: `HTTP ${installRes.status}` }));
        console.error(`Failed to install skill ${skillId}: ${(data as { error?: string }).error}`);
        failedSkills.push(skillId);
      }
    }
  }

  // Remove orientation skill via daemon
  const orientationDir = resolve(dir, "home", ".claude", "skills", "orientation");
  if (existsSync(orientationDir)) {
    const delRes = await daemonFetch(
      urlOf(
        client.api.minds[":name"].skills[":skill"].$url({
          param: { name: mindName, skill: "orientation" },
        }),
      ),
      { method: "DELETE" },
    );
    if (!delRes.ok) {
      const data = await delRes.json().catch(() => ({ error: `HTTP ${delRes.status}` }));
      console.error(`Failed to uninstall orientation skill: ${(data as { error?: string }).error}`);
    }
  }

  if (failedSkills.length > 0) {
    console.error(`Warning: failed to install skills: ${failedSkills.join(", ")}`);
  }

  const sproutRes = await daemonFetch(
    urlOf(client.api.minds[":name"].sprout.$url({ param: { name: mindName } })),
    { method: "POST" },
  );
  if (!sproutRes.ok) {
    const data = await sproutRes.json().catch(() => ({ error: `HTTP ${sproutRes.status}` }));
    console.error((data as { error?: string }).error ?? "Failed to update stage");
    process.exit(1);
  }

  // Restart with sprouted context
  const res = await daemonFetch(
    urlOf(client.api.minds[":name"].restart.$url({ param: { name: mindName } })),
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
}
