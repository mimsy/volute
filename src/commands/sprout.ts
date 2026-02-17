import { cpSync, existsSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { agentDir, findAgent, setAgentStage } from "../lib/registry.js";
import { composeTemplate, findTemplatesRoot } from "../lib/template.js";

const ORIENTATION_MARKER = "You don't have a soul yet";

export async function run(_args: string[]) {
  const agentName = process.env.VOLUTE_AGENT;
  if (!agentName) {
    console.error("volute sprout must be run by an agent (VOLUTE_AGENT not set)");
    process.exit(1);
  }

  const entry = findAgent(agentName);
  if (!entry) {
    console.error(`Unknown agent: ${agentName}`);
    process.exit(1);
  }

  if (entry.stage !== "seed") {
    console.error(`${agentName} is not a seed — already at stage "${entry.stage}"`);
    process.exit(1);
  }

  const dir = agentDir(agentName);
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

  // Install full skills: compose template, copy skills, remove orientation
  const templatesRoot = findTemplatesRoot();
  const { composedDir, manifest } = composeTemplate(templatesRoot, "agent-sdk");
  try {
    const skillsDir = resolve(dir, manifest.skillsDir);
    const composedSkillsDir = resolve(composedDir, manifest.skillsDir);

    // Copy full skills from template (must match the skill list in agents.ts seed creation)
    for (const skill of ["volute-agent", "memory", "sessions"]) {
      const src = resolve(composedSkillsDir, skill);
      if (existsSync(src)) {
        cpSync(src, resolve(skillsDir, skill), { recursive: true });
      }
    }

    // Remove orientation skill
    const orientationPath = resolve(skillsDir, "orientation");
    if (existsSync(orientationPath)) {
      rmSync(orientationPath, { recursive: true, force: true });
    }
  } finally {
    rmSync(composedDir, { recursive: true, force: true });
  }

  // Flip stage only after skills are successfully installed
  setAgentStage(agentName, "mind");

  // Restart with sprouted context
  const { daemonFetch } = await import("../lib/daemon-client.js");
  const { getClient, urlOf } = await import("../lib/api-client.js");
  const client = getClient();

  const res = await daemonFetch(
    urlOf(client.api.agents[":name"].restart.$url({ param: { name: agentName } })),
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

  console.log("Sprouted! You now have full agent capabilities.");
}
