import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { voluteHome } from "./registry.js";

const TAG = "[migrate]";

function log(msg: string): void {
  console.error(`${TAG} ${msg}`);
}

/**
 * One-time migration: rename agent → mind across the filesystem.
 * Called from daemon startup before registry is read. Every step is
 * idempotent — safe to re-run after a partial failure.
 *
 * Steps:
 *  1. Bridge VOLUTE_AGENTS_DIR → VOLUTE_MINDS_DIR env var
 *  2. Rename agents.json → minds.json (with stage value update)
 *  3. Rename agents/ → minds/ directory
 *  4. Rename agent.log → mind.log in each mind's state dir
 *  5. Rename Linux users agent-<name> → mind-<name> (when isolation enabled)
 *  6. Update /etc/profile.d/volute.sh env vars
 */
export function migrateAgentsToMinds(): void {
  const home = voluteHome();

  bridgeEnvVar();

  const names = migrateRegistry(home);

  migrateMindsDirectory(home);

  migrateLogFiles(home, names);

  migrateLinuxUsers(names);

  migrateProfileScript();
}

/** Bridge legacy VOLUTE_AGENTS_DIR so mindDir() works during migration. */
function bridgeEnvVar(): void {
  if (process.env.VOLUTE_AGENTS_DIR && !process.env.VOLUTE_MINDS_DIR) {
    process.env.VOLUTE_MINDS_DIR = process.env.VOLUTE_AGENTS_DIR;
    log(`bridged VOLUTE_AGENTS_DIR=${process.env.VOLUTE_AGENTS_DIR} → VOLUTE_MINDS_DIR`);
  }
}

/**
 * Rename agents.json → minds.json, updating stage: "mind" → "sprouted".
 * Returns the list of mind names from the registry (needed for later steps).
 * Throws on write failure so the daemon doesn't start with a missing registry.
 */
function migrateRegistry(home: string): string[] {
  const oldPath = resolve(home, "agents.json");
  const newPath = resolve(home, "minds.json");

  // Already migrated or no old registry — read names from whichever exists
  if (!existsSync(oldPath) || existsSync(newPath)) {
    return readNamesFromRegistry(newPath);
  }

  const raw = readFileSync(oldPath, "utf-8");
  const entries = JSON.parse(raw) as Array<{ name: string; stage?: string }>;

  for (const entry of entries) {
    if (entry.stage === "mind") {
      entry.stage = "sprouted";
    }
  }

  // Write new registry — let errors propagate (critical failure)
  writeFileSync(newPath, `${JSON.stringify(entries, null, 2)}\n`);

  // Backup old file — non-critical
  try {
    renameSync(oldPath, `${oldPath}.bak`);
  } catch {
    // Backup failed — not critical, old file will just remain
  }

  log("renamed agents.json → minds.json");
  return entries.map((e) => e.name);
}

function readNamesFromRegistry(path: string): string[] {
  if (!existsSync(path)) return [];
  try {
    const entries = JSON.parse(readFileSync(path, "utf-8")) as Array<{ name: string }>;
    return entries.map((e) => e.name);
  } catch {
    return [];
  }
}

/** Rename ~/.volute/agents/ → ~/.volute/minds/ (only for default directory layout). */
function migrateMindsDirectory(home: string): void {
  // Skip if using a custom directory — the directory itself doesn't need renaming
  if (process.env.VOLUTE_MINDS_DIR) return;

  const oldDir = resolve(home, "agents");
  const newDir = resolve(home, "minds");

  if (existsSync(oldDir) && !existsSync(newDir)) {
    try {
      renameSync(oldDir, newDir);
      log("renamed agents/ → minds/");
    } catch (err) {
      log(`failed to rename agents/ → minds/: ${err}`);
    }
  }
}

/** Rename agent.log → mind.log in each mind's state/logs directory. */
function migrateLogFiles(home: string, names: string[]): void {
  for (const name of names) {
    const logsDir = resolve(home, "state", name, "logs");
    const oldLog = resolve(logsDir, "agent.log");
    const newLog = resolve(logsDir, "mind.log");

    if (existsSync(oldLog) && !existsSync(newLog)) {
      try {
        renameSync(oldLog, newLog);
        log(`renamed ${name} agent.log → mind.log`);
      } catch (err) {
        log(`failed to rename ${name} log file: ${err}`);
      }
    }
  }
}

/**
 * Rename Linux users from agent-<name> to mind-<name> when isolation is enabled.
 * Uses usermod -l (login rename) and groupmod -n (group rename).
 */
function migrateLinuxUsers(names: string[]): void {
  if (process.env.VOLUTE_ISOLATION !== "user") return;

  const oldPrefix = "agent-";
  const newPrefix = process.env.VOLUTE_USER_PREFIX ?? "mind-";

  // Don't migrate if custom prefix isn't the default new prefix
  // (someone may have intentionally set a different prefix)
  if (newPrefix !== "mind-") return;

  for (const name of names) {
    const oldUser = `${oldPrefix}${name}`;
    const newUser = `${newPrefix}${name}`;

    // Check if old user exists
    try {
      execFileSync("id", [oldUser], { stdio: "ignore" });
    } catch {
      continue; // Old user doesn't exist — skip
    }

    // Check if new user already exists
    try {
      execFileSync("id", [newUser], { stdio: "ignore" });
      continue; // New user already exists — skip
    } catch {
      // New user doesn't exist — proceed with rename
    }

    // Rename the login
    try {
      execFileSync("usermod", ["-l", newUser, oldUser], {
        stdio: ["ignore", "ignore", "pipe"],
      });
      log(`renamed user ${oldUser} → ${newUser}`);
    } catch (err) {
      const stderr = (err as { stderr?: Buffer })?.stderr?.toString().trim();
      log(`failed to rename user ${oldUser}: ${stderr || err}`);
      continue; // Skip group rename if user rename failed
    }

    // Rename the per-user group (created automatically by useradd)
    try {
      execFileSync("getent", ["group", oldUser], { stdio: "ignore" });
      execFileSync("groupmod", ["-n", newUser, oldUser], {
        stdio: ["ignore", "ignore", "pipe"],
      });
      log(`renamed group ${oldUser} → ${newUser}`);
    } catch {
      // Group may not exist or rename may fail — non-critical
    }
  }
}

/** Update /etc/profile.d/volute.sh to use VOLUTE_MINDS_DIR instead of VOLUTE_AGENTS_DIR. */
function migrateProfileScript(): void {
  const profilePath = "/etc/profile.d/volute.sh";
  if (!existsSync(profilePath)) return;

  try {
    const content = readFileSync(profilePath, "utf-8");
    if (!content.includes("VOLUTE_AGENTS_DIR")) return; // Already migrated or not relevant

    const updated = content.replace(/VOLUTE_AGENTS_DIR/g, "VOLUTE_MINDS_DIR");
    writeFileSync(profilePath, updated);
    log("updated /etc/profile.d/volute.sh: VOLUTE_AGENTS_DIR → VOLUTE_MINDS_DIR");
  } catch (err) {
    log(`failed to update profile script: ${err}`);
  }
}
