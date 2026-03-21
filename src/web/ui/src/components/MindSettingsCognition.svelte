<script lang="ts">
import type { MindConfig } from "@volute/api";
import { onMount } from "svelte";
import { type AiModel, fetchAiModels, fetchMindConfig, updateMindConfig } from "../lib/client";

let { name, template }: { name: string; template?: string } = $props();

let config: MindConfig | null = $state(null);
let models: AiModel[] = $state([]);
let editModel = $state("");
let editThinking = $state("");
let editMaxThinking = $state("");
let editBudget = $state("");
let editPeriod = $state("");
let editCompaction = $state("");
let error = $state("");
let saving: string | null = $state(null);

const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh"];

// Map template → compatible providers
const TEMPLATE_PROVIDERS: Record<string, string[]> = {
  claude: ["anthropic"],
  codex: ["openai-codex"],
  pi: [], // pi supports all providers — empty means no filter
};

let compatibleProviders = $derived(template ? (TEMPLATE_PROVIDERS[template] ?? []) : []);

let enabledModels = $derived(
  models
    .filter((m) => m.enabled)
    .filter((m) => compatibleProviders.length === 0 || compatibleProviders.includes(m.provider)),
);

/** Find the matching model ID from the enabled list, handling partial matches */
function resolveModelId(raw: string): string {
  if (!raw) return "";
  // Exact match
  if (enabledModels.some((m) => m.id === raw)) return raw;
  // Model ID might be stored without version suffix — find a match
  const match = enabledModels.find((m) => m.id.startsWith(raw) || raw.startsWith(m.id));
  return match?.id ?? raw;
}

let resolvedModel = $derived(resolveModelId(editModel));
let isOtherModel = $derived(
  resolvedModel !== "" && !enabledModels.some((m) => m.id === resolvedModel),
);
let showMaxThinking = $derived(editThinking !== "off");

function loadEditFields(c: MindConfig) {
  editModel = c.config.model ?? "";
  editThinking = c.config.thinkingLevel ?? "off";
  editMaxThinking = c.config.maxThinkingTokens != null ? String(c.config.maxThinkingTokens) : "";
  editBudget = c.config.tokenBudget != null ? String(c.config.tokenBudget) : "";
  editPeriod =
    c.config.tokenBudgetPeriodMinutes != null ? String(c.config.tokenBudgetPeriodMinutes) : "";
  editCompaction =
    c.config.compaction?.maxContextTokens != null
      ? String(c.config.compaction.maxContextTokens)
      : "";
}

function parseBudgetInt(val: string): number | null {
  if (!val.trim()) return null;
  const n = parseInt(val, 10);
  return isNaN(n) ? null : n;
}

async function saveField(field: string, fn: () => Promise<void>) {
  saving = field;
  error = "";
  try {
    await fn();
    const c = await fetchMindConfig(name);
    config = c;
    loadEditFields(c);
  } catch (e) {
    error = e instanceof Error ? e.message : "Save failed";
  }
  saving = null;
}

function saveModel(value: string) {
  editModel = value;
  if (!value) return;
  saveField("model", () => updateMindConfig(name, { model: value }));
}

function saveThinking() {
  saveField("thinking", () => updateMindConfig(name, { thinkingLevel: editThinking }));
}

function saveMaxThinking() {
  saveField("maxThinking", () =>
    updateMindConfig(name, {
      maxThinkingTokens: parseBudgetInt(editMaxThinking),
    }),
  );
}

function saveBudget() {
  saveField("budget", () => updateMindConfig(name, { tokenBudget: parseBudgetInt(editBudget) }));
}

function savePeriod() {
  saveField("period", () =>
    updateMindConfig(name, {
      tokenBudgetPeriodMinutes: parseBudgetInt(editPeriod),
    }),
  );
}

function saveCompaction() {
  saveField("compaction", () =>
    updateMindConfig(name, {
      compaction: { maxContextTokens: parseBudgetInt(editCompaction) },
    }),
  );
}

function handleModelSelect(e: Event) {
  const value = (e.target as HTMLSelectElement).value;
  if (value === "__other__") {
    editModel = "";
  } else {
    saveModel(value);
  }
}

onMount(async () => {
  try {
    const [c, m] = await Promise.all([fetchMindConfig(name), fetchAiModels()]);
    config = c;
    models = m;
    loadEditFields(c);
  } catch (e) {
    error = e instanceof Error ? e.message : "Failed to load config";
  }
});
</script>

{#if config}
  {#if template}
    <div class="setting-row">
      <span class="setting-label">Template</span>
      <div class="setting-control">
        <span class="template-badge">{template}</span>
      </div>
    </div>
  {/if}

  <div class="setting-row">
    <span class="setting-label">Model</span>
    <div class="setting-control">
      {#if isOtherModel}
        <input
          class="setting-input"
          type="text"
          bind:value={editModel}
          onblur={() => saveModel(editModel)}
          placeholder="Model ID"
        />
        <button
          class="setting-hint-btn"
          onclick={() => {
            editModel = enabledModels[0]?.id ?? "";
            if (editModel) saveModel(editModel);
          }}>back</button
        >
      {:else}
        <select class="setting-select" value={resolvedModel} onchange={handleModelSelect}>
          <option value="">--</option>
          {#each enabledModels as model (model.id)}
            <option value={model.id}>{model.name}</option>
          {/each}
          <option value="__other__">other...</option>
        </select>
      {/if}
    </div>
  </div>

  <div class="setting-row">
    <span class="setting-label">Thinking</span>
    <div class="setting-control">
      <select
        class="setting-select"
        bind:value={editThinking}
        onchange={saveThinking}
      >
        {#each thinkingLevels as level (level)}
          <option value={level}>{level}</option>
        {/each}
      </select>
    </div>
  </div>

  {#if showMaxThinking}
    <div class="setting-row">
      <span class="setting-label">Max tokens</span>
      <div class="setting-control">
        <input
          class="setting-input narrow"
          type="number"
          bind:value={editMaxThinking}
          onblur={saveMaxThinking}
          placeholder="default"
        />
      </div>
    </div>
  {/if}

  <div class="setting-row">
    <span class="setting-label">Budget</span>
    <div class="setting-control">
      <input
        class="setting-input narrow"
        type="number"
        bind:value={editBudget}
        onblur={saveBudget}
        placeholder="tokens"
      />
      <span class="setting-hint">per</span>
      <input
        class="setting-input narrow"
        type="number"
        bind:value={editPeriod}
        onblur={savePeriod}
        placeholder="min"
      />
      <span class="setting-hint">min</span>
    </div>
  </div>

  <div class="setting-row">
    <span class="setting-label">Context</span>
    <div class="setting-control">
      <input
        class="setting-input narrow"
        type="number"
        bind:value={editCompaction}
        onblur={saveCompaction}
        placeholder="150000"
      />
      <span class="setting-hint">tokens</span>
    </div>
  </div>

  {#if error}
    <div class="error">{error}</div>
  {/if}
{/if}

<style>
  .setting-row {
    display: flex;
    align-items: center;
    padding: 4px 0;
  }

  .setting-label {
    width: 100px;
    flex-shrink: 0;
    font-size: 14px;
    color: var(--text-1);
  }

  .setting-control {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .setting-input,
  .setting-select {
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 4px 8px;
    font-size: 14px;
    font-family: inherit;
    color: inherit;
  }

  .setting-input {
    width: 100%;
  }

  .setting-input.narrow {
    width: 80px;
    flex: 0 0 80px;
  }

  .setting-select {
    width: 100%;
  }

  .setting-hint {
    font-size: 13px;
    color: var(--text-2);
    white-space: nowrap;
  }

  .setting-hint-btn {
    font-size: 13px;
    color: var(--text-2);
    background: none;
    border: none;
    cursor: pointer;
    padding: 4px 8px;
    text-decoration: underline;
  }

  .template-badge {
    font-size: 13px;
    color: var(--text-1);
    background: var(--bg-3);
    padding: 2px 8px;
    border-radius: var(--radius);
  }

  .error {
    color: var(--red);
    font-size: 13px;
    padding: 4px 0;
  }
</style>
