<script lang="ts">
import type { SharedSkill } from "@volute/api";
import { onMount } from "svelte";
import {
  type AiModel,
  createSeedMind,
  fetchAiModels,
  fetchPrompts,
  fetchSharedSkills,
  startMind,
} from "../lib/client";
import Modal from "./Modal.svelte";
import Input from "./ui/Input.svelte";

const SEED_DEFAULTS = ["orientation", "memory"];

let { onClose, onCreated }: { onClose: () => void; onCreated: (name: string) => void } = $props();

let name = $state("");
let description = $state("");
let model = $state("");
let loading = $state(false);
let error = $state("");
let showAdvanced = $state(false);
let seedSoul = $state("");
let defaultSeedSoul = $state("");
let sharedSkills = $state<SharedSkill[]>([]);
let selectedSkills = $state<Set<string>>(new Set(SEED_DEFAULTS));
let aiModels = $state<AiModel[]>([]);
let modelSearch = $state("");
let showModelPicker = $state(false);

let enabledModels = $derived(aiModels.filter((m) => m.enabled));
let selectedModel = $derived(enabledModels.find((m) => m.id === model));
let modelSuggestions = $derived(
  modelSearch.trim()
    ? enabledModels
        .filter((m) => {
          const q = modelSearch.toLowerCase();
          return (
            m.id.toLowerCase().includes(q) ||
            m.name.toLowerCase().includes(q) ||
            m.provider.toLowerCase().includes(q)
          );
        })
        .slice(0, 12)
    : enabledModels.slice(0, 12),
);
let canSubmit = $derived(!loading && !!name.trim());

onMount(() => {
  fetchPrompts()
    .then((prompts) => {
      const p = prompts.find((p) => p.key === "seed_soul");
      if (p) {
        defaultSeedSoul = p.content;
        seedSoul = p.content;
      }
    })
    .catch((e) => {
      console.error("Failed to load prompt templates:", e);
    });
  fetchSharedSkills()
    .then((skills) => {
      sharedSkills = skills;
    })
    .catch((e) => {
      console.error("Failed to load shared skills:", e);
    });
  fetchAiModels()
    .then((models) => {
      aiModels = models;
    })
    .catch((e) => {
      console.error("Failed to load AI models:", e);
    });
});

function toggleSkill(id: string) {
  const next = new Set(selectedSkills);
  if (next.has(id)) {
    next.delete(id);
  } else {
    next.add(id);
  }
  selectedSkills = next;
}

async function handleSubmit() {
  const trimmed = name.trim();
  if (!trimmed) return;
  loading = true;
  error = "";
  try {
    const customSoul = showAdvanced && seedSoul !== defaultSeedSoul ? seedSoul : undefined;
    const customSkills = showAdvanced ? [...selectedSkills] : undefined;
    await createSeedMind(trimmed, {
      description: description.trim() || undefined,
      model: model || undefined,
      seedSoul: customSoul,
      skills: customSkills,
    });
    await startMind(trimmed);
    onCreated(trimmed);
  } catch (e) {
    error = e instanceof Error ? e.message : "Failed to create";
    loading = false;
  }
}
</script>

<Modal size="340px" {onClose}>
  <div class="modal-content">
    <div class="modal-title">Plant a seed</div>

    <label class="field">
      <span class="label">Name</span>
      <Input
        autofocus
        bind:value={name}
        placeholder="e.g. luna"
        onkeydown={(e) => e.key === "Enter" && handleSubmit()}
      />
    </label>

    <label class="field">
      <span class="label">Description (optional)</span>
      <Input
        bind:value={description}
        placeholder="A curious mind who loves poetry..."
        onkeydown={(e) => e.key === "Enter" && handleSubmit()}
      />
    </label>

    {#if enabledModels.length > 0}
      <div class="field">
        <span class="label">Model (optional)</span>
        {#if selectedModel}
          <button class="model-selected" onclick={() => { model = ""; showModelPicker = true; modelSearch = ""; }} type="button">
            <span class="model-selected-name">{selectedModel.name}</span>
            <span class="model-selected-provider">{selectedModel.provider}</span>
            <span class="model-selected-clear">×</span>
          </button>
        {:else}
          <div class="model-picker">
            <Input
              type="text"
              placeholder="Search models..."
              bind:value={modelSearch}
              onfocus={() => { showModelPicker = true; }}
              onblur={() => { setTimeout(() => { showModelPicker = false; }, 150); }}
            />
            {#if showModelPicker && modelSuggestions.length > 0}
              <div class="model-dropdown">
                {#each modelSuggestions as m (m.id)}
                  <button class="model-option" onclick={() => { model = m.id; showModelPicker = false; modelSearch = ""; }} type="button">
                    <span class="model-option-name">{m.name}</span>
                    <span class="model-option-provider">{m.provider}</span>
                  </button>
                {/each}
              </div>
            {/if}
          </div>
        {/if}
      </div>
    {/if}

    <button class="advanced-toggle" onclick={() => showAdvanced = !showAdvanced}>
      <span class="caret">{showAdvanced ? "\u25BC" : "\u25B6"}</span> Advanced
    </button>

    {#if showAdvanced}
      <label class="field">
        <span class="label">Seed SOUL template</span>
        <textarea
          bind:value={seedSoul}
          class="textarea"
          rows="6"
          placeholder="SOUL.md template for this seed..."
        ></textarea>
        <span class="hint">Variables: {"${name}"}, {"${description}"}</span>
      </label>

      {#if sharedSkills.length > 0}
        <div class="field">
          <span class="label">Skills</span>
          <div class="skill-list">
            {#each sharedSkills as skill}
              <label class="skill-item">
                <input
                  type="checkbox"
                  checked={selectedSkills.has(skill.id)}
                  onchange={() => toggleSkill(skill.id)}
                />
                <span class="skill-name">{skill.id}</span>
              </label>
            {/each}
          </div>
        </div>
      {/if}
    {/if}

    {#if error}
      <div class="error">{error}</div>
    {/if}

    <div class="actions">
      <button class="cancel-btn" onclick={onClose}>Cancel</button>
      <button
        class="plant-btn"
        onclick={handleSubmit}
        disabled={!canSubmit}
        style:opacity={canSubmit ? 1 : 0.5}
      >
        {loading ? "Planting..." : "Plant"}
      </button>
    </div>
  </div>
</Modal>

<style>
  .modal-content {
    padding: 24px;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .modal-title {
    font-weight: 600;
    color: var(--text-0);
    font-size: 15px;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .label {
    color: var(--text-2);
    font-size: 12px;
  }

  /* --- Model picker --- */

  .model-picker {
    position: relative;
  }

  .model-dropdown {
    position: absolute;
    top: 100%;
    left: 0;
    right: 0;
    z-index: 10;
    max-height: 200px;
    overflow-y: auto;
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-top: none;
    border-radius: 0 0 var(--radius) var(--radius);
  }

  .model-option {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    padding: 8px 10px;
    font-size: 13px;
    font-family: inherit;
    background: none;
    border: none;
    border-bottom: 1px solid var(--border);
    color: var(--text-0);
    cursor: pointer;
    text-align: left;
  }

  .model-option:last-child { border-bottom: none; }
  .model-option:hover { background: var(--bg-3); }

  .model-option-name {
    color: var(--text-0);
  }

  .model-option-provider {
    color: var(--text-2);
    font-size: 11px;
  }

  .model-selected {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 8px 10px;
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--text-0);
    font-size: 14px;
    font-family: inherit;
    cursor: pointer;
    text-align: left;
  }

  .model-selected:hover {
    border-color: var(--border-bright);
  }

  .model-selected-name {
    flex: 1;
  }

  .model-selected-provider {
    color: var(--text-2);
    font-size: 11px;
  }

  .model-selected-clear {
    color: var(--text-2);
    font-size: 14px;
    margin-left: 4px;
  }

  .model-selected-clear:hover {
    color: var(--red);
  }

  .error {
    color: var(--red);
    font-size: 12px;
  }

  .actions {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
  }

  .cancel-btn {
    padding: 6px 14px;
    background: var(--bg-2);
    color: var(--text-1);
    border-radius: var(--radius);
    font-size: 13px;
    border: 1px solid var(--border);
  }

  .plant-btn {
    padding: 6px 14px;
    background: var(--yellow);
    color: var(--bg-0);
    border-radius: var(--radius);
    font-size: 13px;
    font-weight: 600;
  }

  .advanced-toggle {
    background: transparent;
    color: var(--text-2);
    font-size: 12px;
    font-family: inherit;
    border: none;
    cursor: pointer;
    padding: 0;
    display: flex;
    align-items: center;
    gap: 4px;
    transition: color 0.15s;
  }

  .advanced-toggle:hover {
    color: var(--text-1);
  }

  .caret {
    font-size: 8px;
  }

  .textarea {
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 8px 10px;
    color: var(--text-0);
    font-family: inherit;
    outline: none;
    resize: vertical;
    min-height: 80px;
    font-size: 13px;
    line-height: 1.5;
  }

  .hint {
    color: var(--text-2);
    font-size: 11px;
    font-family: inherit;
  }

  .skill-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .skill-item {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
    color: var(--text-1);
    cursor: pointer;
  }

  .skill-name {
    font-family: var(--mono);
  }
</style>
