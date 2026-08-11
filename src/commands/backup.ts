import { existsSync, readdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { getClient, urlOf } from "@volute/cli/lib/api-client.js";
import { command, subcommands } from "@volute/cli/lib/command.js";
import { daemonFetch } from "@volute/cli/lib/daemon-client.js";
import { promptLine, promptPassword } from "@volute/cli/lib/prompt.js";
import {
  type BackupState,
  type BackupSummary,
  restoreStagedDb,
  type Snapshot,
} from "@volute/daemon/lib/backup/backup.js";
import { RESTIC_INSTALL_HINT, resticVersion } from "@volute/daemon/lib/backup/restic.js";
import { getServiceMode, modeLabel, stopService } from "@volute/daemon/lib/config/service-mode.js";
import { _resetConfigCache, readGlobalConfig } from "@volute/daemon/lib/config/setup.js";
import { chownMindDir, wrapForIsolation } from "@volute/daemon/lib/mind/isolation.js";
import { voluteHome, voluteSystemDir } from "@volute/daemon/lib/mind/registry.js";
import { exec, execInherit } from "@volute/daemon/lib/util/exec.js";
import { stopDaemon } from "./down.js";

function printPassphrase(password: string): void {
  console.log("\n┌─ BACKUP PASSPHRASE ─────────────────────────────────────────┐");
  console.log(`   ${password}`);
  console.log("└─────────────────────────────────────────────────────────────┘");
  console.log("Store this somewhere OFF this machine (password manager, paper).");
  console.log("Without it your backups are unreadable — this is the exact");
  console.log("scenario (lost machine) that backups exist for.\n");
  console.log(`It is also stored in ${resolve(voluteSystemDir(), "secrets.json")}`);
}

async function apiError(res: Response, fallback: string): Promise<never> {
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  console.error(data.error ?? `${fallback}: HTTP ${res.status}`);
  process.exit(1);
}

const initCmd = command({
  name: "volute backup init",
  description: "Configure the backup repository and initialize it",
  flags: {
    repo: { type: "string", description: "Restic repository (path, s3:..., b2:..., sftp:...)" },
    password: { type: "string", description: "Repository passphrase (generated if omitted)" },
  },
  examples: [
    "volute backup init --repo /mnt/backups/volute",
    "volute backup init --repo s3:s3.amazonaws.com/my-bucket/volute",
  ],
  run: async ({ flags }) => {
    let repo = flags.repo;
    if (!repo) {
      repo = (await promptLine("Repository (path or s3:/b2:/sftp: URL): ")).trim();
      if (!repo) {
        console.error("A repository is required.");
        process.exit(1);
      }
    }

    const client = getClient();
    const putRes = await daemonFetch(urlOf(client.api.v1.backup.config.$url()), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repository: repo, password: flags.password ?? "" }),
    });
    if (!putRes.ok) await apiError(putRes, "Failed to save backup config");

    const initRes = await daemonFetch(urlOf(client.api.v1.backup.init.$url()), { method: "POST" });
    if (!initRes.ok) await apiError(initRes, "Failed to initialize repository");
    const { password } = (await initRes.json()) as { password: string | null };

    console.log(`Backup repository initialized: ${repo}`);
    if (password) printPassphrase(password);
    console.log("\nEnable scheduled backups with: volute backup schedule --enable");
    console.log("Or run one now with: volute backup create");
  },
});

const createCmd = command({
  name: "volute backup create",
  description: "Run a backup now",
  flags: {},
  run: async () => {
    const client = getClient();
    console.log("Running backup (this may take a while on first run)...");
    const res = await daemonFetch(urlOf(client.api.v1.backup.run.$url()), { method: "POST" });
    if (!res.ok) await apiError(res, "Backup failed");
    const summary = (await res.json()) as BackupSummary;
    const addedMB = (summary.dataAdded / 1024 / 1024).toFixed(1);
    console.log(`Snapshot ${summary.snapshotId.slice(0, 8)} created.`);
    console.log(
      `  Files: ${summary.totalFilesProcessed} processed, ${summary.filesNew} new, ${summary.filesChanged} changed`,
    );
    console.log(`  Data added: ${addedMB} MB in ${(summary.durationMs / 1000).toFixed(1)}s`);
  },
});

const listCmd = command({
  name: "volute backup list",
  description: "List backup snapshots",
  flags: {},
  run: async () => {
    const client = getClient();
    const res = await daemonFetch(urlOf(client.api.v1.backup.snapshots.$url()));
    if (!res.ok) await apiError(res, "Failed to list snapshots");
    const snapshots = (await res.json()) as Snapshot[];
    if (snapshots.length === 0) {
      console.log("No snapshots yet. Run: volute backup create");
      return;
    }
    console.log("ID        TIME                      HOST");
    for (const s of snapshots) {
      console.log(`${s.short_id}  ${new Date(s.time).toLocaleString().padEnd(24)}  ${s.hostname}`);
    }
  },
});

const scheduleCmd = command({
  name: "volute backup schedule",
  description: "Enable, disable, or set the backup schedule",
  flags: {
    enable: { type: "boolean", description: "Enable scheduled backups" },
    disable: { type: "boolean", description: "Disable scheduled backups" },
    cron: { type: "string", description: 'Cron expression (default "0 3 * * *")' },
  },
  examples: ["volute backup schedule --enable", 'volute backup schedule --cron "30 4 * * *"'],
  run: async ({ flags }) => {
    const body: Record<string, unknown> = {};
    if (flags.enable) body.enabled = true;
    if (flags.disable) body.enabled = false;
    if (flags.cron) body.schedule = flags.cron;
    if (Object.keys(body).length === 0) {
      console.error("Nothing to change. Use --enable, --disable, or --cron.");
      process.exit(1);
    }
    const client = getClient();
    const res = await daemonFetch(urlOf(client.api.v1.backup.config.$url()), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) await apiError(res, "Failed to update schedule");
    const config = (await res.json()) as {
      enabled?: boolean;
      schedule?: string;
      repository?: string;
      hasPassword?: boolean;
    };
    console.log(
      `Scheduled backups ${config.enabled ? "enabled" : "disabled"} (cron: ${config.schedule})`,
    );
    if (config.enabled && (!config.repository || !config.hasPassword)) {
      console.log("Note: backups will NOT run until a repository is set up: volute backup init");
    }
  },
});

const statusCmd = command({
  name: "volute backup status",
  description: "Show backup configuration and last run",
  flags: {},
  run: async () => {
    const client = getClient();
    const res = await daemonFetch(urlOf(client.api.v1.backup.status.$url()));
    if (!res.ok) await apiError(res, "Failed to get backup status");
    const status = (await res.json()) as {
      resticInstalled: boolean;
      resticVersion: string | null;
      installHint: string | null;
      config: {
        repository?: string;
        schedule?: string;
        enabled?: boolean;
        hasPassword: boolean;
        includeSessions?: boolean;
      };
      state: BackupState;
    };
    console.log(`Restic: ${status.resticVersion ?? "not installed"}`);
    if (status.installHint) console.log(`  ${status.installHint}`);
    console.log(`Repository: ${status.config.repository ?? "not configured"}`);
    console.log(`Passphrase: ${status.config.hasPassword ? "set" : "not set"}`);
    console.log(
      `Schedule: ${status.config.enabled ? `enabled (${status.config.schedule})` : "disabled"}`,
    );
    if (status.state.lastRun) {
      console.log(`Last successful backup: ${new Date(status.state.lastRun).toLocaleString()}`);
      if (status.state.lastSnapshotId) {
        console.log(`  Snapshot: ${status.state.lastSnapshotId.slice(0, 8)}`);
      }
      if (status.state.pruneError) {
        console.log(`  Retention prune failed: ${status.state.pruneError}`);
      }
    } else {
      console.log("Last successful backup: never");
    }
    if (status.state.lastError) {
      const at = status.state.lastAttempt
        ? ` at ${new Date(status.state.lastAttempt).toLocaleString()}`
        : "";
      console.log(`Last attempt failed${at}: ${status.state.lastError}`);
    }
  },
});

const restoreCmd = command({
  name: "volute backup restore",
  description: "Restore the whole system from a backup (stops the daemon)",
  flags: {
    repo: { type: "string", description: "Restic repository (defaults to configured one)" },
    snapshot: { type: "string", description: "Snapshot ID (default: latest)" },
    target: { type: "string", description: "Restore to this directory instead of in place" },
    yes: { type: "boolean", description: "Skip confirmation" },
  },
  examples: [
    "volute backup restore",
    "volute backup restore --repo s3:s3.amazonaws.com/my-bucket/volute",
    "volute backup restore --snapshot 1a2b3c4d --target /tmp/inspect",
  ],
  run: async ({ flags }) => {
    if (!(await resticVersion())) {
      console.error(`restic is not installed. ${RESTIC_INSTALL_HINT}`);
      process.exit(1);
    }

    // Existing install: read repo/password/env from config + secrets.
    // Fresh machine: --repo flag + prompted password + ambient env (AWS_* etc.).
    const backupConfig = readGlobalConfig().backup ?? {};
    const repo = flags.repo ?? backupConfig.repository;
    if (!repo) {
      console.error("No repository configured. Pass --repo <repository>.");
      process.exit(1);
    }
    let password = backupConfig.password ?? process.env.RESTIC_PASSWORD;
    if (!password) {
      password = await promptPassword("Repository passphrase: ");
      if (!password) {
        console.error("A passphrase is required.");
        process.exit(1);
      }
    }
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...backupConfig.env,
      RESTIC_REPOSITORY: repo,
      RESTIC_PASSWORD: password,
    };
    const snapshot = flags.snapshot ?? "latest";

    // Inspection mode: extract somewhere else and stop.
    if (flags.target) {
      console.log(`Restoring snapshot ${snapshot} to ${flags.target}...`);
      await execInherit("restic", ["restore", snapshot, "--target", flags.target], { env });
      console.log("Done. (Inspection restore: no databases moved, no daemon touched.)");
      return;
    }

    // Restic restores absolute paths. If the snapshot was taken on a machine
    // with a different volute home, an in-place restore would put everything
    // at the old path and silently restore nothing here — refuse up front.
    const home = voluteHome();
    try {
      const out = await exec("restic", ["snapshots", snapshot, "--json"], { env });
      const snaps = JSON.parse(out || "[]") as { paths?: string[] }[];
      const paths = snaps[0]?.paths ?? [];
      if (paths.length > 0 && !paths.includes(home)) {
        console.error(`This snapshot was taken with a different volute home:`);
        for (const p of paths) console.error(`  ${p}`);
        console.error(`This machine's volute home is ${home}, so an in-place restore would`);
        console.error("write to the old paths and restore nothing here. Either set VOLUTE_HOME");
        console.error("to match, or inspect with --target and move files manually.");
        process.exit(1);
      }
    } catch (err) {
      console.error(
        `Could not read snapshot ${snapshot}: ${err instanceof Error ? err.message : err}`,
      );
      process.exit(1);
    }

    if (!flags.yes) {
      console.log(`This restores snapshot ${snapshot} from ${repo} IN PLACE:`);
      console.log("  - the daemon will be stopped");
      console.log("  - current system state and mind files will be overwritten");
      console.log(
        "  - minds wake with fresh sessions (transcripts are excluded unless includeSessions was on)",
      );
      const answer = (await promptLine("Continue? [y/N] ")).trim().toLowerCase();
      if (answer !== "y" && answer !== "yes") {
        console.log("Aborted.");
        return;
      }
    }

    // Stop the daemon (service or manual) so no process holds the DBs we replace.
    const mode = getServiceMode();
    if (mode !== "manual") {
      console.log(`Stopping volute (${modeLabel(mode)})...`);
      try {
        await stopService(mode);
      } catch (err) {
        console.error(`Failed to stop service: ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
    } else {
      const result = await stopDaemon();
      if (!result.stopped && result.reason !== "not-running") {
        console.error("Could not stop the daemon — aborting so live databases aren't replaced.");
        process.exit(1);
      }
    }

    try {
      console.log(`Restoring snapshot ${snapshot} from ${repo}...`);
      await execInherit("restic", ["restore", snapshot, "--target", "/"], { env });

      // Move staged (consistent) DB copies into their live locations. The live
      // volute.db is excluded from snapshots — the staged copy is the ONLY one,
      // so its absence means the restore did not recover the system database.
      const systemDir = voluteSystemDir();
      const staging = resolve(systemDir, "backup-staging");
      const mainLive = resolve(systemDir, "volute.db");
      if (!restoreStagedDb(resolve(staging, "volute.db"), mainLive)) {
        console.error(`\nFATAL: staged database not found at ${staging}/volute.db.`);
        console.error("The snapshot does not contain a system database; whatever volute.db");
        console.error("was on disk before this restore is still in place, and it does NOT");
        console.error("match the restored files. Do not trust this system until you restore");
        console.error("a snapshot that includes backup-staging/volute.db.");
        process.exit(1);
      }
      console.log(`Restored database: ${mainLive}`);
      const stagedExt = resolve(staging, "extension-data");
      if (existsSync(stagedExt)) {
        for (const id of readdirSync(stagedExt)) {
          const live = resolve(systemDir, "extension-data", id, "data.db");
          if (restoreStagedDb(resolve(stagedExt, id, "data.db"), live)) {
            console.log(`Restored database: ${live}`);
          } else {
            console.error(`  Warning: no staged copy for extension DB ${id} — skipped.`);
          }
        }
      }
      rmSync(staging, { recursive: true, force: true });
    } catch (err) {
      console.error(`\nRestore failed: ${err instanceof Error ? err.message : err}`);
      console.error("The system is in a PARTIALLY RESTORED state (the daemon is stopped and");
      console.error("some files may already be overwritten). Do not start the daemon.");
      console.error("Fix the underlying problem and re-run: volute backup restore");
      process.exit(1);
    }

    // Rehydrate node_modules for every restored mind (deps are excluded from
    // backups). Failures here are non-fatal — the databases are already in
    // place and each mind's install can be re-run by hand.
    // Re-read config from the restored files: it carries the isolation mode,
    // which the isolation helpers read from VOLUTE_ISOLATION (only the service
    // environment sets that; a CLI invocation must derive it itself).
    _resetConfigCache();
    if (readGlobalConfig().setup?.isolation === "user") {
      process.env.VOLUTE_ISOLATION = "user";
    }
    const { readAllMinds, mindDir } = await import("@volute/daemon/lib/mind/registry.js");
    const seen = new Set<string>();
    for (const mind of await readAllMinds()) {
      const dir = mind.dir ?? mindDir(mind.name);
      if (seen.has(dir) || !existsSync(resolve(dir, "package.json"))) continue;
      seen.add(dir);
      console.log(`Installing dependencies for ${mind.name}...`);
      try {
        // Under per-mind user isolation, restore runs as root: re-own the
        // restored files and install as the mind's user, like mind create does.
        await chownMindDir(dir, mind.name);
        const [cmd, args] = await wrapForIsolation(
          "npm",
          ["install", "--no-audit", "--no-fund"],
          mind.name,
        );
        await exec(cmd, args, { cwd: dir });
      } catch (err) {
        console.error(
          `  npm install failed for ${mind.name}: ${err instanceof Error ? err.message : err}`,
        );
        console.error(`  Run it manually: cd ${dir} && npm install`);
      }
    }

    console.log("\nRestore complete. Start the daemon with: volute up");
    console.log("Minds' memory and history are restored from the snapshot.");
  },
});

const cmd = subcommands({
  name: "volute backup",
  description: "Back up and restore the whole volute system (restic-based)",
  commands: {
    init: { description: "Configure and initialize the backup repository", run: initCmd.execute },
    create: { description: "Run a backup now", run: createCmd.execute },
    list: { description: "List snapshots", run: listCmd.execute },
    schedule: { description: "Enable/disable/set the backup schedule", run: scheduleCmd.execute },
    status: { description: "Show backup configuration and last run", run: statusCmd.execute },
    restore: { description: "Restore the system from a backup", run: restoreCmd.execute },
  },
});

export const run = cmd.execute;
