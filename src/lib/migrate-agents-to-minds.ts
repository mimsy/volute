import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { voluteHome } from "./registry.js";

/**
 * One-time migration: rename agents.json → minds.json, agents/ → minds/.
 * Called from daemon startup before registry is read. Idempotent.
 */
export function migrateAgentsToMinds(): void {
  const home = voluteHome();

  // Rename registry file
  const oldRegistry = resolve(home, "agents.json");
  const newRegistry = resolve(home, "minds.json");
  if (existsSync(oldRegistry) && !existsSync(newRegistry)) {
    try {
      // Also update stage values in the registry
      const entries = JSON.parse(readFileSync(oldRegistry, "utf-8"));
      for (const entry of entries) {
        if (entry.stage === "mind") {
          entry.stage = "sprouted";
        }
      }
      writeFileSync(newRegistry, `${JSON.stringify(entries, null, 2)}\n`);
      renameSync(oldRegistry, `${oldRegistry}.bak`);
      console.error("[migrate] renamed agents.json → minds.json");
    } catch (err) {
      console.error("[migrate] failed to rename agents.json:", err);
    }
  }

  // Rename agents directory (only if not using custom VOLUTE_MINDS_DIR)
  if (!process.env.VOLUTE_MINDS_DIR && !process.env.VOLUTE_AGENTS_DIR) {
    const oldDir = resolve(home, "agents");
    const newDir = resolve(home, "minds");
    if (existsSync(oldDir) && !existsSync(newDir)) {
      try {
        renameSync(oldDir, newDir);
        console.error("[migrate] renamed agents/ → minds/");
      } catch (err) {
        console.error("[migrate] failed to rename agents directory:", err);
      }
    }
  }
}
