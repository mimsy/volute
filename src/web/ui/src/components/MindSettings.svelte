<script lang="ts">
import type { Mind, MindConfig } from "@volute/api";
import { onMount } from "svelte";
import { fetchMindConfig, fetchMinds, updateMindConfig } from "../lib/client";
import { data } from "../lib/stores.svelte";
import MindSettingsAdvanced from "./MindSettingsAdvanced.svelte";
import MindSettingsEnv from "./MindSettingsEnv.svelte";
import MindSettingsProfile from "./MindSettingsProfile.svelte";
import MindSkills from "./MindSkills.svelte";

let { mind: initialMind }: { mind: Mind } = $props();

let mind = $derived(data.minds.find((m) => m.name === initialMind.name) ?? initialMind);
let name = $derived(mind.name);

const SECTIONS = [
  { id: "profile", label: "Profile" },
  { id: "cognition", label: "Model" },
  { id: "skills", label: "Skills" },
  { id: "environment", label: "Environment" },
  { id: "advanced", label: "Advanced" },
] as const;

let activeSection = $state("profile");
let scrollContainer: HTMLDivElement;
let sectionEls: Record<string, HTMLElement> = {};

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

// Cognition state (inline for Phase 1)
let config = $state<MindConfig | null>(null);
let editModel = $state("");
let editThinking = $state("off");
let editBudget = $state("");
let editPeriod = $state("");
let saving = $state<string | null>(null);
let configError = $state("");

function loadEditFields(c: MindConfig) {
  editModel = c.config.model ?? "";
  editThinking = c.config.thinkingLevel ?? "off";
  editBudget = c.config.tokenBudget != null ? String(c.config.tokenBudget) : "";
  editPeriod =
    c.config.tokenBudgetPeriodMinutes != null ? String(c.config.tokenBudgetPeriodMinutes) : "";
}

async function refreshConfig() {
  try {
    const c = await fetchMindConfig(name);
    config = c;
    loadEditFields(c);
    configError = "";
  } catch {
    configError = "Failed to load config";
  }
}

onMount(() => {
  refreshConfig();
  setupObserver();
});

function setupObserver() {
  if (!scrollContainer) return;
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          activeSection = entry.target.id;
        }
      }
    },
    { root: scrollContainer, rootMargin: "-20% 0px -70% 0px", threshold: 0 },
  );
  for (const el of Object.values(sectionEls)) {
    if (el) observer.observe(el);
  }
  return () => observer.disconnect();
}

function scrollTo(id: string) {
  sectionEls[id]?.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function saveField(field: string, value: unknown) {
  saving = field;
  configError = "";
  try {
    await updateMindConfig(name, { [field]: value });
    const c = await fetchMindConfig(name);
    config = c;
    loadEditFields(c);
  } catch (e) {
    configError = e instanceof Error ? e.message : "Failed to save";
  }
  saving = null;
}

function handleModelSave() {
  saveField("model", editModel);
}

function handleThinkingChange(e: Event) {
  const val = (e.target as HTMLSelectElement).value;
  editThinking = val;
  saveField("thinkingLevel", val);
}

function parseBudgetInt(val: string): number | null {
  const trimmed = val.trim();
  if (!trimmed) return null;
  const parsed = parseInt(trimmed, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

async function handleBudgetSave() {
  saving = "budget";
  configError = "";
  try {
    await updateMindConfig(name, {
      tokenBudget: parseBudgetInt(editBudget),
      tokenBudgetPeriodMinutes: parseBudgetInt(editPeriod),
    });
    const c = await fetchMindConfig(name);
    config = c;
    loadEditFields(c);
  } catch (e) {
    configError = e instanceof Error ? e.message : "Failed to save";
  }
  saving = null;
}

function handleKeydown(e: KeyboardEvent, action: () => void) {
  if (e.key === "Enter") action();
}

async function handleUpdated() {
  data.minds = await fetchMinds();
}
</script>

<div class="settings">
  <nav class="section-nav">
    {#each SECTIONS as s}
      <button
        class="nav-pill"
        class:active={activeSection === s.id}
        onclick={() => scrollTo(s.id)}
      >{s.label}</button>
    {/each}
  </nav>

  <div class="settings-body" bind:this={scrollContainer}>
    <!-- Profile -->
    <section id="profile" bind:this={sectionEls.profile}>
      <MindSettingsProfile {mind} onUpdated={handleUpdated} />
    </section>

    <!-- Model & Cognition -->
    <section id="cognition" bind:this={sectionEls.cognition}>
      <div class="section-header">
        <span class="section-title">Model</span>
        <span class="section-subtitle">Cognition and resource limits</span>
      </div>

      {#if configError}
        <div class="error">{configError}</div>
      {/if}

      {#if config}
        <div class="setting-row">
          <label class="setting-label" for="model-input">Model</label>
          <div class="setting-control">
            <input
              id="model-input"
              type="text"
              class="setting-input"
              bind:value={editModel}
              onkeydown={(e) => handleKeydown(e, handleModelSave)}
              onblur={handleModelSave}
              placeholder="e.g. claude-sonnet-4-6"
            />
          </div>
        </div>

        <div class="setting-row">
          <label class="setting-label" for="thinking-select">Thinking</label>
          <div class="setting-control">
            <select
              id="thinking-select"
              class="setting-select"
              value={editThinking}
              onchange={handleThinkingChange}
              disabled={saving !== null}
            >
              {#each THINKING_LEVELS as level}
                <option value={level}>{level}</option>
              {/each}
            </select>
          </div>
        </div>

        <div class="setting-row">
          <label class="setting-label" for="budget-input">Token budget</label>
          <div class="setting-control">
            <input
              id="budget-input"
              type="number"
              class="setting-input narrow"
              bind:value={editBudget}
              onkeydown={(e) => handleKeydown(e, handleBudgetSave)}
              onblur={handleBudgetSave}
              placeholder="tokens"
            />
            <span class="setting-hint">per</span>
            <input
              id="period-input"
              type="number"
              class="setting-input narrow"
              bind:value={editPeriod}
              onkeydown={(e) => handleKeydown(e, handleBudgetSave)}
              onblur={handleBudgetSave}
              placeholder="60"
            />
            <span class="setting-hint">min</span>
          </div>
        </div>
      {:else}
        <div class="empty">Loading...</div>
      {/if}
    </section>

    <!-- Skills -->
    <section id="skills" bind:this={sectionEls.skills}>
      <MindSkills {name} />
    </section>

    <!-- Environment -->
    <section id="environment" bind:this={sectionEls.environment}>
      <MindSettingsEnv {name} />
    </section>

    <!-- Advanced -->
    <section id="advanced" bind:this={sectionEls.advanced}>
      <div class="section-header">
        <span class="section-title">Advanced</span>
        <span class="section-subtitle">Status and system info</span>
      </div>
      <MindSettingsAdvanced {mind} />
    </section>
  </div>
</div>

<style>
  .settings {
    display: flex;
    flex-direction: column;
    height: 100%;
    animation: fadeIn 0.2s ease both;
  }

  .section-nav {
    display: flex;
    gap: 4px;
    padding: 8px 16px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
    overflow-x: auto;
    background: var(--bg-0);
    position: sticky;
    top: 0;
    z-index: 1;
  }

  .nav-pill {
    padding: 4px 12px;
    border-radius: 12px;
    font-size: 12px;
    font-weight: 500;
    background: none;
    color: var(--text-2);
    border: 1px solid transparent;
    white-space: nowrap;
    transition: color 0.15s, background 0.15s;
  }

  .nav-pill:hover {
    color: var(--text-1);
    background: var(--bg-2);
  }

  .nav-pill.active {
    background: var(--accent-dim);
    color: var(--accent);
  }

  .settings-body {
    flex: 1;
    overflow: auto;
    padding: 0 16px 32px;
    max-width: 720px;
    margin: 0 auto;
    width: 100%;
  }

  section {
    padding-top: 24px;
    margin-bottom: 8px;
  }

  .section-header {
    display: flex;
    align-items: baseline;
    gap: 10px;
    margin-bottom: 12px;
  }

  .section-title {
    font-size: 15px;
    font-weight: 600;
    color: var(--text-0);
  }

  .section-subtitle {
    font-size: 12px;
    color: var(--text-2);
  }

  .error {
    color: var(--red);
    padding: 8px 0;
    font-size: 13px;
  }

  .empty {
    color: var(--text-2);
    padding: 12px 0;
    font-size: 14px;
  }

  /* Cognition fields */
  .setting-row {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 6px 0;
  }

  .setting-label {
    width: 100px;
    flex-shrink: 0;
    font-size: 14px;
    color: var(--text-1);
  }

  .setting-control {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 1;
  }

  .setting-input {
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 4px 8px;
    font-size: 14px;
    color: var(--text-0);
    flex: 1;
    font-family: inherit;
  }

  .setting-input.narrow {
    width: 80px;
    flex: 0 0 80px;
  }

  .setting-input:focus {
    border-color: var(--accent);
    outline: none;
  }

  .setting-select {
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 4px 8px;
    font-size: 14px;
    color: var(--text-0);
    font-family: inherit;
  }

  .setting-hint {
    font-size: 13px;
    color: var(--text-2);
    flex-shrink: 0;
  }
</style>
