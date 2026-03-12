<script lang="ts">
import type { Mind, Site } from "@volute/api";
import type { ExtensionInfo } from "../lib/extensions";
import { mindDotColor } from "../lib/format";
import type { Selection } from "../lib/navigate";
import { activeMinds } from "../lib/stores.svelte";

let {
  minds,
  sites,
  extensions,
  selection,
  onHome,
  onSelectMind,
  onSelectMindSection,
  onSelectNotes,
  onSelectPages,
  onSelectExtension,
  onSelectSettings,
  onSeed,
}: {
  minds: Mind[];
  sites: Site[];
  extensions: ExtensionInfo[];
  selection: Selection;
  onHome: () => void;
  onSelectMind: (name: string) => void;
  onSelectMindSection: (name: string, section: string) => void;
  onSelectNotes: () => void;
  onSelectPages: () => void;
  onSelectExtension: (extensionId: string) => void;
  onSelectSettings: () => void;
  onSeed: () => void;
} = $props();

let sortedMinds = $derived(
  [...minds].sort((a, b) => {
    const aActive = activeMinds.has(a.name) ? 0 : a.status === "running" ? 1 : 2;
    const bActive = activeMinds.has(b.name) ? 0 : b.status === "running" ? 1 : 2;
    if (aActive !== bActive) return aActive - bActive;
    return a.name.localeCompare(b.name);
  }),
);

let activeMindName = $derived.by(() => {
  if (selection.tab !== "system") return null;
  if (selection.kind === "mind") return selection.name;
  if (selection.kind === "mind-note" || selection.kind === "mind-page") return selection.mind;
  return null;
});

let activeMindSection = $derived.by(() => {
  if (selection.tab !== "system") return null;
  if (selection.kind === "mind") return selection.section ?? "info";
  if (selection.kind === "mind-note") return "notes";
  if (selection.kind === "mind-page") return "pages";
  return null;
});

const CORE_MIND_SECTIONS = [
  { key: "info", label: "Info" },
  { key: "notes", label: "Notes" },
  { key: "pages", label: "Pages" },
  { key: "files", label: "Files" },
  { key: "settings", label: "Settings" },
] as const;

let allMindSections = $derived([
  ...CORE_MIND_SECTIONS,
  ...extensions
    .filter((e) => e.id !== "notes" && e.id !== "pages")
    .flatMap((ext) =>
      (ext.mindSections ?? []).map((s) => ({ key: `ext:${ext.id}:${s.id}`, label: s.label })),
    ),
]);
</script>

<div class="sidebar-inner">
  <div class="sections">
    <!-- System -->
    <div class="section">
      <button
        class="section-toggle"
        class:active={selection.tab === "system" && selection.kind === "home"}
        onclick={onHome}
      >
        <span>System</span>
      </button>
      <div class="sub-items">
        <button
          class="sub-item"
          class:active={selection.tab === "system" && (selection.kind === "notes" || selection.kind === "note")}
          onclick={onSelectNotes}
        >Notes</button>
        <button
          class="sub-item"
          class:active={selection.tab === "system" && (selection.kind === "pages" || selection.kind === "site" || selection.kind === "page")}
          onclick={onSelectPages}
        >Pages</button>
        {#each extensions.filter((e) => e.id !== "notes" && e.id !== "pages") as ext}
          {#if ext.systemSections}
            {#each ext.systemSections as section}
              <button
                class="sub-item"
                class:active={selection.tab === "system" && selection.kind === "extension" && selection.extensionId === ext.id}
                onclick={() => onSelectExtension(ext.id)}
              >{section.label}</button>
            {/each}
          {/if}
        {/each}
        <button
          class="sub-item"
          class:active={selection.tab === "system" && selection.kind === "settings"}
          onclick={onSelectSettings}
        >Settings</button>
      </div>
    </div>

    <!-- Minds -->
    <div class="section">
      <div class="section-header-row">
        <span class="section-label">Minds</span>
        <button class="section-add" onclick={onSeed} title="Plant a seed">+</button>
      </div>
      <div class="mind-list">
        {#each sortedMinds as mind}
          <div>
            <button
              class="mind-item"
              class:active={activeMindName === mind.name}
              onclick={() => onSelectMind(mind.name)}
            >
              <span
                class="status-dot"
                class:iridescent={activeMinds.has(mind.name)}
                style:background={activeMinds.has(mind.name) ? undefined : mindDotColor(mind)}
              ></span>
              <span class="mind-item-name">{mind.displayName ?? mind.name}</span>
            </button>
            {#if activeMindName === mind.name}
              <div class="mind-sub-items">
                {#each allMindSections as sec}
                  <button
                    class="mind-sub-item"
                    class:active={activeMindSection === sec.key}
                    onclick={() => onSelectMindSection(mind.name, sec.key)}
                  >{sec.label}</button>
                {/each}
              </div>
            {/if}
          </div>
        {/each}
      </div>
    </div>
  </div>
</div>

<style>
  .sidebar-inner {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
  }

  .sections {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
    padding-top: 4px;
  }

  .section {
    margin-bottom: 2px;
  }

  .section-header-row {
    display: flex;
    align-items: center;
    padding: 6px 12px;
    padding-right: 8px;
  }

  .section-label {
    flex: 1;
    color: var(--text-2);
    font-family: var(--display);
    font-size: 16px;
    font-weight: 300;
    letter-spacing: 0.02em;
  }

  .section-toggle {
    display: flex;
    align-items: center;
    gap: 4px;
    width: 100%;
    padding: 6px 12px;
    background: none;
    color: var(--text-2);
    font-family: var(--display);
    font-size: 16px;
    font-weight: 300;
    letter-spacing: 0.02em;
    text-align: left;
    border-radius: var(--radius);
    margin: 0 4px;
  }

  .section-toggle:hover {
    color: var(--text-1);
  }

  .section-toggle.active {
    color: var(--text-0);
    background: var(--bg-2);
  }

  .sub-items {
    display: flex;
    flex-direction: column;
  }

  .sub-item {
    padding: 5px 12px 5px 28px;
    background: none;
    color: var(--text-2);
    font-size: 13px;
    text-align: left;
    border-radius: var(--radius);
    margin: 0 4px;
    cursor: pointer;
  }

  .sub-item:hover {
    color: var(--text-1);
    background: var(--bg-2);
  }

  .sub-item.active {
    color: var(--text-0);
    background: var(--bg-2);
  }

  .section-add {
    background: none;
    color: var(--text-2);
    font-size: 15px;
    padding: 2px 6px;
    border-radius: var(--radius);
    flex-shrink: 0;
  }

  .section-add:hover {
    color: var(--text-0);
    background: var(--bg-2);
  }

  .mind-list {
    display: flex;
    flex-direction: column;
  }

  .mind-item {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 6px 12px 6px 26px;
    font-size: 14px;
    color: var(--text-1);
    transition: background 0.1s;
    cursor: pointer;
    background: none;
    text-align: left;
    margin: 0 4px;
    border-radius: var(--radius);
  }

  .mind-item:hover {
    background: var(--bg-2);
  }

  .mind-item.active {
    background: var(--bg-2);
    color: var(--text-0);
  }

  .mind-item-name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 500;
  }

  .mind-sub-items {
    display: flex;
    flex-direction: column;
  }

  .mind-sub-item {
    padding: 4px 12px 4px 42px;
    background: none;
    color: var(--text-2);
    font-size: 12px;
    text-align: left;
    border-radius: var(--radius);
    margin: 0 4px;
    cursor: pointer;
  }

  .mind-sub-item:hover {
    color: var(--text-1);
    background: var(--bg-2);
  }

  .mind-sub-item.active {
    color: var(--text-0);
    background: var(--bg-2);
  }

  .status-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .status-dot.iridescent {
    animation: iridescent 3s ease-in-out infinite;
  }

  @keyframes iridescent {
    0%   { background: #4ade80; }
    16%  { background: #60a5fa; }
    33%  { background: #c084fc; }
    50%  { background: #f472b6; }
    66%  { background: #fbbf24; }
    83%  { background: #34d399; }
    100% { background: #4ade80; }
  }

  @media (max-width: 767px) {
    .mind-item {
      padding: 10px 12px 10px 26px;
    }

    .section-toggle {
      padding: 8px 12px;
    }

    .status-dot {
      width: 8px;
      height: 8px;
    }
  }
</style>
