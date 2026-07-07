<script lang="ts">
import {
  Button,
  EmptyState,
  ErrorMessage,
  Input,
  SettingRow,
  SettingsSection,
  Toggle,
} from "@volute/ui";
import { onMount } from "svelte";
import {
  type BackupRunSummary,
  type BackupSnapshot,
  type BackupState,
  fetchBackupStatus,
  initBackupRepo,
  listBackupSnapshots,
  runBackupNow,
  saveBackupConfig,
} from "../../lib/client";

const ENV_PLACEHOLDER = "AWS_ACCESS_KEY_ID=...\nAWS_SECRET_ACCESS_KEY=...";

// Restic status
let resticInstalled = $state(false);
let resticVersion = $state<string | null>(null);
let installHint = $state<string | null>(null);
let backupState = $state<BackupState>({});

// Repository
let editRepository = $state("");
let editPassword = $state("");
let hasPassword = $state(false);
let envKeys = $state<string[]>([]);
let envText = $state("");
let envEdited = $state(false);

// Schedule
let scheduleEnabled = $state(false);
let editSchedule = $state("0 3 * * *");
let keepDaily = $state("");
let keepWeekly = $state("");
let keepMonthly = $state("");
let includeSessions = $state(false);

// Actions
let initializing = $state(false);
let generatedPassword = $state<string | null>(null);
let passwordCopied = $state(false);
let copyError = $state("");
let running = $state(false);
let runResult = $state<BackupRunSummary | null>(null);
let runError = $state("");
let snapshots = $state<BackupSnapshot[] | null>(null);
let snapshotsLoading = $state(false);
let snapshotsError = $state("");

// General
let error = $state("");
let loading = $state(true);
let loadFailed = $state(false);
let saveStatus = $state<"idle" | "saving" | "saved">("idle");
let saveTimer: ReturnType<typeof setTimeout> | undefined;

function parseKeepInt(val: string): number | undefined {
  if (!val.trim()) return undefined;
  const n = parseInt(val, 10);
  return Number.isNaN(n) ? undefined : n;
}

function parseEnvText(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1);
  }
  return env;
}

async function refreshStatus() {
  const status = await fetchBackupStatus();
  resticInstalled = status.resticInstalled;
  resticVersion = status.resticVersion;
  installHint = status.installHint;
  backupState = status.state;
  editRepository = status.config.repository ?? "";
  hasPassword = status.config.hasPassword;
  envKeys = status.config.envKeys;
  scheduleEnabled = status.config.enabled ?? false;
  editSchedule = status.config.schedule ?? "0 3 * * *";
  keepDaily = status.config.keep?.daily != null ? String(status.config.keep.daily) : "";
  keepWeekly = status.config.keep?.weekly != null ? String(status.config.keep.weekly) : "";
  keepMonthly = status.config.keep?.monthly != null ? String(status.config.keep.monthly) : "";
  includeSessions = status.config.includeSessions ?? false;
}

async function save() {
  saveStatus = "saving";
  clearTimeout(saveTimer);
  try {
    await saveBackupConfig({
      repository: editRepository,
      schedule: editSchedule,
      enabled: scheduleEnabled,
      keep: {
        daily: parseKeepInt(keepDaily),
        weekly: parseKeepInt(keepWeekly),
        monthly: parseKeepInt(keepMonthly),
      },
      includeSessions,
      // Empty string means "keep existing password"
      password: editPassword,
      // env replaces all stored credentials, so only send it when edited
      env: envEdited ? parseEnvText(envText) : undefined,
    });
    editPassword = "";
    envText = "";
    envEdited = false;
    error = "";
    saveStatus = "saved";
    saveTimer = setTimeout(() => {
      saveStatus = "idle";
    }, 1500);
  } catch (e) {
    error = e instanceof Error ? e.message : "Save failed";
    saveStatus = "idle";
    return;
  }
  try {
    await refreshStatus();
  } catch (e) {
    console.error("Failed to refresh backup status", e);
  }
}

async function handleInit() {
  initializing = true;
  generatedPassword = null;
  await save();
  if (!error) {
    try {
      const res = await initBackupRepo();
      generatedPassword = res.password;
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to initialize repository";
    }
    try {
      await refreshStatus();
    } catch (e) {
      console.error("Failed to refresh backup status", e);
    }
  }
  initializing = false;
}

async function copyPassword() {
  if (!generatedPassword) return;
  copyError = "";
  try {
    await navigator.clipboard.writeText(generatedPassword);
  } catch {
    copyError = "Copy failed — select the text manually";
    return;
  }
  passwordCopied = true;
  setTimeout(() => {
    passwordCopied = false;
  }, 1500);
}

async function handleRunNow() {
  running = true;
  runResult = null;
  runError = "";
  try {
    runResult = await runBackupNow();
  } catch (e) {
    runError = e instanceof Error ? e.message : "Backup failed";
    running = false;
    return;
  }
  try {
    await refreshStatus();
    if (snapshots) await loadSnapshots();
  } catch (e) {
    console.error("Failed to refresh backup status", e);
  }
  running = false;
}

async function loadSnapshots() {
  snapshotsLoading = true;
  snapshotsError = "";
  try {
    snapshots = await listBackupSnapshots();
  } catch (e) {
    snapshotsError = e instanceof Error ? e.message : "Failed to list snapshots";
  }
  snapshotsLoading = false;
}

function fmtMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fmtDuration(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

onMount(async () => {
  try {
    await refreshStatus();
  } catch (e) {
    error = e instanceof Error ? e.message : "Failed to load backup status";
    loadFailed = true;
  }
  loading = false;
});
</script>

<div class="backups">
  {#if loading}
    <p class="loading-text">Loading...</p>
  {:else if loadFailed}
    <ErrorMessage message={error} />
  {:else}
    <SettingsSection title="Status">
      {#if resticInstalled}
        <div class="status-line">{resticVersion}</div>
      {:else}
        <div class="status-line missing">restic not installed</div>
        {#if installHint}
          <div class="install-hint">{installHint}</div>
        {/if}
      {/if}
      {#if backupState.lastRun}
        <div class="last-run">
          Last successful backup {new Date(backupState.lastRun).toLocaleString()}
          {#if backupState.lastSnapshotId}
            &middot; snapshot <span class="mono">{backupState.lastSnapshotId.slice(0, 8)}</span>
          {/if}
          {#if backupState.lastDurationMs != null}
            &middot; {fmtDuration(backupState.lastDurationMs)}
          {/if}
        </div>
      {/if}
      {#if backupState.pruneError}
        <div class="prune-warning">Retention prune failed: {backupState.pruneError}</div>
      {/if}
      {#if backupState.lastError}
        <ErrorMessage
          message={backupState.lastAttempt
            ? `Last attempt failed ${new Date(backupState.lastAttempt).toLocaleString()}: ${backupState.lastError}`
            : `Last attempt failed: ${backupState.lastError}`}
        />
      {/if}
    </SettingsSection>

    <SettingsSection title="Repository">
      <SettingRow label="Repository">
        <Input
          type="text"
          variant="mono"
          style="flex:1"
          bind:value={editRepository}
          placeholder="/mnt/backups/volute or s3:s3.amazonaws.com/bucket/path"
        />
      </SettingRow>
      <SettingRow label="Passphrase">
        <Input
          type="password"
          style="flex:1"
          bind:value={editPassword}
          placeholder={hasPassword ? "(unchanged)" : "passphrase"}
        />
      </SettingRow>
      <div class="env-block">
        <div class="env-label">Credentials</div>
        <textarea
          class="env-textarea"
          rows="3"
          bind:value={envText}
          oninput={() => (envEdited = true)}
          placeholder={ENV_PLACEHOLDER}
        ></textarea>
        <div class="env-hint">
          One KEY=VALUE per line, passed to restic. Saving replaces all stored credentials.
          {#if envKeys.length > 0}
            Currently set: {envKeys.join(", ")}
          {/if}
        </div>
      </div>
      <div class="section-actions">
        <Button
          variant="secondary"
          onclick={handleInit}
          disabled={!resticInstalled || initializing || !editRepository.trim()}
        >
          {initializing ? "Initializing..." : "Initialize repository"}
        </Button>
      </div>
      {#if generatedPassword}
        <div class="password-reveal">
          <div class="password-warning">
            Store this passphrase somewhere off this machine &mdash; without it your backups are
            unreadable. It will not be shown again.
          </div>
          <div class="password-row">
            <code class="password-value">{generatedPassword}</code>
            <Button variant="primary" onclick={copyPassword}>
              {passwordCopied ? "Copied" : "Copy"}
            </Button>
          </div>
          {#if copyError}
            <div class="copy-error">{copyError}</div>
          {/if}
        </div>
      {/if}
    </SettingsSection>

    <SettingsSection title="Schedule">
      <SettingRow label="Enabled">
        <Toggle
          checked={scheduleEnabled}
          onchange={() => (scheduleEnabled = !scheduleEnabled)}
          label={scheduleEnabled ? "On" : "Off"}
        />
      </SettingRow>
      <SettingRow label="Cron">
        <Input variant="mono" width="140px" bind:value={editSchedule} placeholder="0 3 * * *" />
      </SettingRow>
      <SettingRow label="Keep">
        <Input type="number" width="60px" bind:value={keepDaily} placeholder="7" />
        <span class="setting-hint">daily</span>
        <Input type="number" width="60px" bind:value={keepWeekly} placeholder="4" />
        <span class="setting-hint">weekly</span>
        <Input type="number" width="60px" bind:value={keepMonthly} placeholder="12" />
        <span class="setting-hint">monthly</span>
      </SettingRow>
      <SettingRow label="Sessions">
        <Toggle
          checked={includeSessions}
          onchange={() => (includeSessions = !includeSessions)}
        />
        <span class="setting-hint wrap">
          Include session transcripts &mdash; Claude transcripts are only inside mind directories on
          user-isolation installs; elsewhere they live in the host ~/.claude and can't be captured.
        </span>
      </SettingRow>
    </SettingsSection>

    <div class="save-row">
      <Button variant="primary" onclick={save} disabled={saveStatus === "saving"}>Save</Button>
      {#if error}
        <ErrorMessage message={error} />
      {:else if saveStatus === "saving"}
        <span class="save-status">Saving...</span>
      {:else if saveStatus === "saved"}
        <span class="save-status saved">Saved</span>
      {/if}
    </div>

    <SettingsSection title="Backups">
      <div class="section-actions">
        <Button variant="secondary" onclick={handleRunNow} disabled={!resticInstalled || running}>
          {running ? "Running backup..." : "Run backup now"}
        </Button>
        <Button
          variant="secondary"
          onclick={loadSnapshots}
          disabled={!resticInstalled || snapshotsLoading}
        >
          {snapshotsLoading ? "Loading..." : snapshots ? "Refresh snapshots" : "Show snapshots"}
        </Button>
      </div>
      {#if runError}
        <ErrorMessage message={runError} />
      {:else if runResult}
        <div class="run-summary">
          Snapshot <span class="mono">{runResult.snapshotId.slice(0, 8)}</span> &middot;
          {runResult.totalFilesProcessed} files processed ({runResult.filesNew} new,
          {runResult.filesChanged} changed) &middot; {fmtMb(runResult.dataAdded)} added &middot;
          {fmtDuration(runResult.durationMs)}
        </div>
      {/if}
      {#if snapshotsError}
        <ErrorMessage message={snapshotsError} />
      {:else if snapshots}
        {#if snapshots.length === 0}
          <EmptyState message="No snapshots yet." />
        {:else}
          <div class="snapshot-list">
            {#each snapshots as snap (snap.id)}
              <div class="snapshot-row">
                <span class="mono">{snap.short_id}</span>
                <span class="snapshot-time">{new Date(snap.time).toLocaleString()}</span>
                <span class="snapshot-host">{snap.hostname}</span>
              </div>
            {/each}
          </div>
        {/if}
      {/if}
    </SettingsSection>
  {/if}
</div>

<style>
  .backups {
    max-width: 720px;
    margin: 0 auto;
  }

  .loading-text {
    color: var(--text-2);
    font-size: 13px;
    text-align: center;
    padding: 20px;
  }

  .status-line {
    font-size: 13px;
    color: var(--text-1);
  }

  .status-line.missing {
    color: var(--red, #f87171);
  }

  .install-hint {
    font-family: var(--mono);
    font-size: 12px;
    color: var(--text-2);
    margin-top: 4px;
    white-space: pre-wrap;
  }

  .last-run {
    font-size: 12px;
    color: var(--text-2);
    margin-top: 6px;
  }

  .mono {
    font-family: var(--mono);
    font-size: 12px;
  }

  .setting-hint {
    font-size: 13px;
    color: var(--text-2);
    white-space: nowrap;
  }

  .setting-hint.wrap {
    white-space: normal;
  }

  .prune-warning {
    font-size: 12px;
    color: var(--yellow, #facc15);
    margin-top: 6px;
  }

  .copy-error {
    font-size: 12px;
    color: var(--red, #f87171);
    margin-top: 6px;
  }

  .env-block {
    padding: 4px 0;
  }

  .env-label {
    font-size: 14px;
    color: var(--text-1);
    margin-bottom: 4px;
  }

  .env-textarea {
    width: 100%;
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 4px 8px;
    font-family: var(--mono);
    font-size: 13px;
    color: var(--text-0);
    resize: vertical;
  }

  .env-textarea:focus {
    border-color: var(--accent);
    outline: none;
  }

  .env-hint {
    font-size: 12px;
    color: var(--text-2);
    margin-top: 4px;
  }

  .section-actions {
    display: flex;
    gap: 6px;
    margin-top: 8px;
  }

  .password-reveal {
    margin-top: 10px;
    border: 1px solid var(--red, #f87171);
    border-radius: var(--radius-lg, 8px);
    padding: 12px;
  }

  .password-warning {
    font-size: 13px;
    color: var(--red, #f87171);
    margin-bottom: 8px;
  }

  .password-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .password-value {
    flex: 1;
    font-family: var(--mono);
    font-size: 13px;
    color: var(--text-0);
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 6px 8px;
    word-break: break-all;
    user-select: all;
  }

  .save-row {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 24px;
    margin-bottom: 24px;
  }

  .save-status {
    font-size: 12px;
    color: var(--text-2);
  }

  .save-status.saved {
    color: var(--green, #4ade80);
  }

  .run-summary {
    font-size: 12px;
    color: var(--text-1);
    margin-top: 8px;
  }

  .snapshot-list {
    display: flex;
    flex-direction: column;
    margin-top: 8px;
  }

  .snapshot-row {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 6px 0;
    border-bottom: 1px solid var(--border);
    font-size: 13px;
    color: var(--text-1);
  }

  .snapshot-row:last-child {
    border-bottom: none;
  }

  .snapshot-time {
    flex: 1;
  }

  .snapshot-host {
    color: var(--text-2);
  }
</style>
