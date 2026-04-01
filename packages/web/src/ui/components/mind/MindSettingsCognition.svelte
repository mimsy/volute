<script lang="ts">
import type { MindConfig } from "@volute/api";
import { ErrorMessage, Input, Select, SettingRow, Toggle } from "@volute/ui";
import { onMount } from "svelte";
import { type AiModel, fetchAiModels, fetchMindConfig, updateMindConfig } from "../../lib/client";

let {
  name,
  template,
  hideBudget = false,
}: { name: string; template?: string; hideBudget?: boolean } = $props();

let config: MindConfig | null = $state(null);
let models: AiModel[] = $state([]);
let editModel = $state("");
let thinkingIndex = $state(0);
let editMaxThinking = $state("");
let editBudget = $state("");
let editPeriod = $state("");
let editCompaction = $state("");
let unescapeNewlines = $state(false);
let error = $state("");
let saving: string | null = $state(null);

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

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
  if (enabledModels.some((m) => m.id === raw)) return raw;
  const match = enabledModels.find((m) => m.id.startsWith(raw) || raw.startsWith(m.id));
  return match?.id ?? raw;
}

// Once models load, resolve editModel to match an enabled model's exact ID
$effect(() => {
  if (enabledModels.length > 0 && editModel) {
    const resolved = resolveModelId(editModel);
    if (resolved !== editModel) {
      editModel = resolved;
    }
  }
});

let isOtherModel = $derived(editModel !== "" && !enabledModels.some((m) => m.id === editModel));
let thinkingLabel = $derived(THINKING_LEVELS[thinkingIndex]);
let showMaxThinking = $derived(template === "claude" && thinkingIndex > 0);

function loadEditFields(c: MindConfig) {
  editModel = c.config.model ?? "";
  const level = c.config.thinkingLevel ?? "off";
  thinkingIndex = Math.max(0, THINKING_LEVELS.indexOf(level as (typeof THINKING_LEVELS)[number]));
  editMaxThinking = c.config.maxThinkingTokens != null ? String(c.config.maxThinkingTokens) : "";
  editBudget = c.config.tokenBudget != null ? String(c.config.tokenBudget) : "";
  editPeriod =
    c.config.tokenBudgetPeriodMinutes != null ? String(c.config.tokenBudgetPeriodMinutes) : "";
  editCompaction =
    c.config.compaction?.maxContextTokens != null
      ? String(c.config.compaction.maxContextTokens)
      : "";
  unescapeNewlines = c.config.unescapeNewlines ?? false;
}

function parseBudgetInt(val: string): number | null {
  if (!val.trim()) return null;
  const n = parseInt(val, 10);
  return Number.isNaN(n) ? null : n;
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
  saveField("thinking", () =>
    updateMindConfig(name, { thinkingLevel: THINKING_LEVELS[thinkingIndex] }),
  );
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

function toggleUnescapeNewlines() {
  unescapeNewlines = !unescapeNewlines;
  saveField("unescapeNewlines", () => updateMindConfig(name, { unescapeNewlines }));
}

function handleModelSelect(e: Event) {
  const value = (e.target as HTMLSelectElement).value;
  if (value === "__other__") {
    editModel = "";
  } else {
    saveModel(value);
  }
}

function handleSliderChange(e: Event) {
  thinkingIndex = parseInt((e.target as HTMLInputElement).value, 10);
  saveThinking();
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
    <SettingRow label="Template">
      <span class="template-badge">{template}</span>
    </SettingRow>
  {/if}

  <SettingRow label="Model">
    {#if isOtherModel}
      <Input
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
      <Select value={editModel} onchange={handleModelSelect}>
        <option value="">--</option>
        {#each enabledModels as model (model.id)}
          <option value={model.id}>{model.name}</option>
        {/each}
        <option value="__other__">other...</option>
      </Select>
    {/if}
  </SettingRow>

  <SettingRow label="Thinking">
    <div class="slider-control">
      <input
        type="range"
        class="thinking-slider"
        min="0"
        max="5"
        step="1"
        value={thinkingIndex}
        onchange={handleSliderChange}
      />
      <span class="slider-label" class:off={thinkingIndex === 0}>{thinkingLabel}</span>
    </div>
  </SettingRow>

  {#if showMaxThinking}
    <SettingRow label="Max tokens">
      <Input
        type="number"
        width="80px"
        bind:value={editMaxThinking}
        onblur={saveMaxThinking}
        placeholder="default"
      />
    </SettingRow>
  {/if}

  {#if !hideBudget}
    <SettingRow label="Budget">
      <Input
        type="number"
        width="80px"
        bind:value={editBudget}
        onblur={saveBudget}
        placeholder="tokens"
      />
      <span class="setting-hint">per</span>
      <Input
        type="number"
        width="80px"
        bind:value={editPeriod}
        onblur={savePeriod}
        placeholder="min"
      />
      <span class="setting-hint">min</span>
    </SettingRow>

    <SettingRow label="Context">
      <Input
        type="number"
        width="80px"
        bind:value={editCompaction}
        onblur={saveCompaction}
        placeholder="150000"
      />
      <span class="setting-hint">tokens</span>
    </SettingRow>
  {/if}

  <SettingRow label="Fix newlines">
    <Toggle checked={unescapeNewlines} onchange={toggleUnescapeNewlines} label="Unescape \\n in messages" />
  </SettingRow>

  <ErrorMessage message={error} />
{/if}

<style>
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

  /* Thinking slider */
  .slider-control {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .thinking-slider {
    flex: 1;
    height: 4px;
    -webkit-appearance: none;
    appearance: none;
    background: var(--border);
    border-radius: 2px;
    outline: none;
    cursor: pointer;
  }

  .thinking-slider::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: var(--accent);
    border: none;
    cursor: pointer;
  }

  .thinking-slider::-moz-range-thumb {
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: var(--accent);
    border: none;
    cursor: pointer;
  }

  .slider-label {
    font-size: 13px;
    color: var(--text-1);
    min-width: 50px;
    text-align: right;
  }

  .slider-label.off {
    color: var(--text-2);
  }
</style>
