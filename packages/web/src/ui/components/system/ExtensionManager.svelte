<script lang="ts">
import { Button, EmptyState, ErrorMessage, SectionHeader } from "@volute/ui";
import { onMount } from "svelte";
import {
  fetchAllExtensions,
  installExtension,
  setExtensionEnabled,
  uninstallExtension,
} from "../../lib/client";
import type { ExtensionManagementInfo } from "../../lib/extensions";

let extensions = $state<ExtensionManagementInfo[]>([]);
let error = $state("");
let loading = $state(true);
let actionLoading = $state<string | null>(null);
let needsRestart = $state(false);
let installPkg = $state("");

function refresh() {
  fetchAllExtensions()
    .then((exts) => {
      extensions = exts;
      loading = false;
      error = "";
    })
    .catch((e) => {
      error = e instanceof Error ? e.message : "Failed to load extensions";
      loading = false;
    });
}

onMount(refresh);

async function toggleEnabled(ext: ExtensionManagementInfo) {
  actionLoading = ext.id;
  error = "";
  try {
    await setExtensionEnabled(ext.id, !ext.enabled);
    ext.enabled = !ext.enabled;
    needsRestart = true;
  } catch (e) {
    error = e instanceof Error ? e.message : "Failed to update";
  }
  actionLoading = null;
}

async function handleInstall() {
  const pkg = installPkg.trim();
  if (!pkg) return;
  actionLoading = "install";
  error = "";
  try {
    await installExtension(pkg);
    installPkg = "";
    needsRestart = true;
    refresh();
  } catch (e) {
    error = e instanceof Error ? e.message : "Failed to install";
  }
  actionLoading = null;
}

async function handleUninstall(ext: ExtensionManagementInfo) {
  if (!ext.package) return;
  actionLoading = ext.id;
  error = "";
  try {
    await uninstallExtension(ext.package);
    needsRestart = true;
    refresh();
  } catch (e) {
    error = e instanceof Error ? e.message : "Failed to uninstall";
  }
  actionLoading = null;
}

let sortedExts = $derived([
  ...extensions.filter((e) => e.source === "builtin"),
  ...extensions.filter((e) => e.source !== "builtin"),
]);
</script>

{#if loading}
  <EmptyState message="Loading..." />
{:else}
  <ErrorMessage message={error} />

  <SectionHeader title="Extensions">
    {#snippet action()}
      <form class="install-form" onsubmit={(e) => { e.preventDefault(); handleInstall(); }}>
        <input
          type="text"
          class="install-input"
          placeholder="npm package name"
          bind:value={installPkg}
          disabled={actionLoading !== null}
        />
        <Button
          variant="primary"
          onclick={handleInstall}
          disabled={actionLoading !== null || !installPkg.trim()}
        >
          {actionLoading === "install" ? "Installing..." : "Install"}
        </Button>
      </form>
    {/snippet}
  </SectionHeader>

  {#if needsRestart}
    <div class="restart-banner">
      Restart the daemon to apply changes.
    </div>
  {/if}

  {#if extensions.length === 0}
    <EmptyState message="No extensions found." />
  {:else}
    <div class="ext-list">
      <div class="column-header">
        <span class="column-label">Enabled</span>
      </div>

      {#each sortedExts as ext (ext.id)}
        <div class="ext-row">
          <label class="enabled-toggle" title={ext.enabled ? "Enabled" : "Disabled"}>
            <input
              type="checkbox"
              checked={ext.enabled}
              disabled={actionLoading !== null}
              onchange={() => toggleEnabled(ext)}
            />
            <span class="toggle-track">
              <span class="toggle-thumb"></span>
            </span>
          </label>
          <div class="ext-info">
            <div class="ext-name">{ext.name}</div>
            {#if ext.description}
              <div class="ext-desc">{ext.description}</div>
            {/if}
            <div class="ext-meta">
              {ext.id} &middot; v{ext.version} &middot; {ext.source}
            </div>
          </div>
          {#if ext.source === "npm" && ext.package}
            <div class="ext-actions">
              <Button
                variant="danger"
                onclick={() => handleUninstall(ext)}
                disabled={actionLoading !== null}
              >
                {actionLoading === ext.id ? "..." : "Uninstall"}
              </Button>
            </div>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
{/if}

<style>
  .install-form {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .install-input {
    background: var(--bg-1);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--text-0);
    font-size: 13px;
    padding: 4px 8px;
    width: 200px;
  }

  .install-input::placeholder {
    color: var(--text-3);
  }

  .install-input:focus {
    outline: none;
    border-color: var(--accent);
  }

  .restart-banner {
    max-width: 720px;
    margin: 0 auto 12px;
    padding: 8px 12px;
    font-size: 13px;
    color: var(--yellow, #facc15);
    border: 1px solid var(--yellow, #facc15);
    border-radius: var(--radius);
    opacity: 0.85;
  }

  .ext-list {
    display: flex;
    flex-direction: column;
    max-width: 720px;
    margin: 0 auto;
  }

  .column-header {
    padding: 0 0 4px;
  }

  .column-label {
    font-size: 11px;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    color: var(--text-3);
  }

  .ext-row {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 0;
    border-bottom: 1px solid var(--border);
  }

  .ext-row:last-child {
    border-bottom: none;
  }

  .ext-row:hover {
    background: var(--bg-2);
  }

  .enabled-toggle {
    flex-shrink: 0;
    cursor: pointer;
    display: flex;
    align-items: center;
  }

  .enabled-toggle input {
    position: absolute;
    opacity: 0;
    width: 0;
    height: 0;
  }

  .toggle-track {
    display: inline-block;
    width: 32px;
    height: 18px;
    border-radius: 9px;
    background: var(--bg-3);
    position: relative;
    transition: background 0.15s;
  }

  .enabled-toggle input:checked + .toggle-track {
    background: var(--accent);
  }

  .toggle-thumb {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: var(--text-2);
    transition: transform 0.15s, background 0.15s;
  }

  .enabled-toggle input:checked + .toggle-track .toggle-thumb {
    transform: translateX(14px);
    background: var(--bg-0);
  }

  .enabled-toggle input:disabled + .toggle-track {
    opacity: 0.5;
  }

  .ext-info {
    flex: 1;
    min-width: 0;
  }

  .ext-name {
    font-size: 14px;
    font-weight: 500;
    color: var(--text-0);
  }

  .ext-desc {
    font-size: 13px;
    color: var(--text-1);
    margin-top: 2px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .ext-meta {
    font-size: 12px;
    color: var(--text-2);
    margin-top: 2px;
  }

  .ext-actions {
    display: flex;
    gap: 4px;
    flex-shrink: 0;
  }
</style>
