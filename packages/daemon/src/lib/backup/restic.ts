import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { BackupConfig } from "../config/setup.js";
import { voluteSystemDir } from "../mind/registry.js";
import { exec } from "../util/exec.js";
import log from "../util/logger.js";

export const RESTIC_INSTALL_HINT =
  "Install restic: `brew install restic` (macOS), `apt-get install restic` (Debian/Ubuntu), or see https://restic.net";

/** Check that the restic binary is on PATH. Returns its version string, or null. */
export async function resticVersion(): Promise<string | null> {
  try {
    const out = await exec("restic", ["version"]);
    return out.trim();
  } catch (err) {
    // ENOENT means "not installed"; anything else (broken binary, EACCES) is a
    // different problem the install hint would misdiagnose — log the real error.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      log.child("backup").warn("restic exists but failed to run", log.errorData(err));
    }
    return null;
  }
}

export function resticEnv(config: BackupConfig): NodeJS.ProcessEnv {
  if (!config.repository) throw new Error("Backup repository is not configured");
  if (!config.password) throw new Error("Backup password is not configured");
  return {
    ...process.env,
    ...config.env,
    RESTIC_REPOSITORY: config.repository,
    RESTIC_PASSWORD: config.password,
  };
}

/** Run restic with the given args. Argv array only — never a shell string. */
export async function runRestic(
  args: string[],
  config: BackupConfig,
  options?: { cwd?: string },
): Promise<string> {
  if (!(await resticVersion())) {
    throw new Error(`restic is not installed. ${RESTIC_INSTALL_HINT}`);
  }
  return exec("restic", args, { cwd: options?.cwd, env: resticEnv(config) });
}

/**
 * Default exclude patterns. Restic matches bare names against any path
 * component, so `node_modules` excludes them at every depth — including inside
 * projects minds created for themselves.
 */
const BASE_EXCLUDES = [
  // dependency trees and build output — rehydrated via lockfiles
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  "dist",
  // mind runtime state that is regenerated
  ".variants",
  ".worktrees",
  ".mind/tmp",
  ".npm",
  // toolchains and caches minds install into their home. home/.local must NOT
  // be excluded wholesale: .local/hooks and .local/bin hold mind-authored hooks
  // and skill shims that are never regenerated — only its toolchain subdirs go.
  "home/.cache",
  "home/.npm",
  "home/.rustup",
  "home/.cargo",
  "home/.local/share",
  "home/.local/state",
  "home/.local/lib",
  "home/.local/pipx",
];

/**
 * System-dir files excluded by absolute path so the patterns can't collide
 * with same-named files inside mind directories. Live DBs are excluded because
 * the backup carries consistent VACUUM INTO copies under backup-staging/.
 */
function systemExcludes(): string[] {
  const sys = voluteSystemDir();
  return [
    resolve(sys, "volute.db"),
    resolve(sys, "volute.db-wal"),
    resolve(sys, "volute.db-shm"),
    `${resolve(sys, "extension-data")}/*/data.db`,
    `${resolve(sys, "extension-data")}/*/data.db-wal`,
    `${resolve(sys, "extension-data")}/*/data.db-shm`,
    `${resolve(sys, "state")}/*/logs`,
    resolve(sys, "daemon.log"),
    resolve(sys, "daemon.pid"),
    resolve(sys, "backup-excludes.txt"),
  ];
}

/**
 * Session transcripts, excluded unless includeSessions. Locations are
 * template-dependent: codex writes under .mind/codex/sessions, pi under
 * .mind/pi-sessions. The Claude Agent SDK writes under home/.claude only when
 * HOME is remapped into the mind dir (user isolation); on other installs its
 * transcripts live in the host ~/.claude, outside every backup root, so
 * includeSessions cannot capture them. Durable history lives in volute.db;
 * a restored mind wakes with a fresh session.
 */
const SESSION_EXCLUDES = [
  "home/.claude/projects",
  "home/.claude/debug",
  "home/.claude/telemetry",
  "home/.claude/todos",
  "home/.claude/session-env",
  ".mind/codex/sessions",
  ".mind/pi-sessions",
];

/**
 * When the repository is a local filesystem path, return its absolute path so
 * the backup can exclude it. A repo that lives inside a backup root (e.g. under
 * ~/.volute) would otherwise be backed up into itself, racing restic against
 * its own transient pack files. Remote backends (s3:, rest:, sftp:, b2:, …)
 * return null — nothing on the local tree to exclude.
 */
export function localRepoPath(config: BackupConfig): string | null {
  const repo = config.repository;
  if (!repo) return null;
  // restic identifies backends by a "scheme:" prefix; a bare path or an
  // explicit "local:" path is a local filesystem repository.
  const scheme = /^([a-z][a-z0-9]*):/i.exec(repo);
  if (scheme && scheme[1].toLowerCase() !== "local") return null;
  return resolve(scheme ? repo.slice(scheme[0].length) : repo);
}

export function buildExcludePatterns(config: BackupConfig): string[] {
  const patterns = [...BASE_EXCLUDES, ...systemExcludes()];
  const repoPath = localRepoPath(config);
  if (repoPath) patterns.push(repoPath);
  if (!config.includeSessions) patterns.push(...SESSION_EXCLUDES);
  return patterns;
}

/** Write the exclude file for a backup run and return its path. */
export function writeExcludeFile(config: BackupConfig): string {
  const path = resolve(voluteSystemDir(), "backup-excludes.txt");
  writeFileSync(path, `${buildExcludePatterns(config).join("\n")}\n`);
  return path;
}
