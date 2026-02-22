import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { findMind, mindDir } from "../lib/registry.js";
import { getSharedSkill, installSkill, STANDARD_SKILLS, uninstallSkill } from "../lib/skills.js";

const ORIENTATION_MARKER = "You don't have a soul yet";

export async function run(_args: string[]) {
  const mindName = process.env.VOLUTE_MIND;
  if (!mindName) {
    console.error("volute sprout must be run by a mind (VOLUTE_MIND not set)");
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

  // Install standard skills from shared pool, remove orientation
  for (const skillId of STANDARD_SKILLS) {
    const shared = await getSharedSkill(skillId);
    if (!shared) {
      console.error(`Shared skill not found: ${skillId} — run 'volute up' to sync built-in skills`);
      continue;
    }
    const skillDir = resolve(dir, "home", ".claude", "skills", skillId);
    if (!existsSync(skillDir)) {
      await installSkill(mindName, dir, skillId);
    }
  }

  // Remove orientation skill
  const orientationDir = resolve(dir, "home", ".claude", "skills", "orientation");
  if (existsSync(orientationDir)) {
    await uninstallSkill(mindName, dir, "orientation");
  }

  // Flip stage via daemon API (mind user can't write to shared minds.json directly)
  const { daemonFetch } = await import("../lib/daemon-client.js");
  const { getClient, urlOf } = await import("../lib/api-client.js");
  const client = getClient();

  const sproutRes = await daemonFetch(
    urlOf(client.api.minds[":name"].sprout.$url({ param: { name: mindName } })),
    { method: "POST" },
  );
  if (!sproutRes.ok) {
    const data = (await sproutRes.json()) as { error?: string };
    console.error(data.error ?? "Failed to update stage");
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
    const data = (await res.json()) as { error?: string };
    console.error(data.error ?? "Failed to restart after sprouting");
    process.exit(1);
  }

  console.log("Sprouted! You now have full mind capabilities.");
}
