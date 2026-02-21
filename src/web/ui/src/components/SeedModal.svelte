<script lang="ts">
import { createSeedMind, startMind } from "../lib/api";

let { onClose, onCreated }: { onClose: () => void; onCreated: (name: string) => void } = $props();

let name = $state("");
let description = $state("");
let template = $state("claude");
let model = $state("");
let loading = $state(false);
let error = $state("");
let nameInput: HTMLInputElement;

$effect(() => {
  nameInput?.focus();
});

async function handleSubmit() {
  const trimmed = name.trim();
  if (!trimmed) return;
  loading = true;
  error = "";
  try {
    await createSeedMind(trimmed, {
      description: description.trim() || undefined,
      template,
      model: model.trim() || undefined,
    });
    await startMind(trimmed);
    onCreated(trimmed);
  } catch (e) {
    error = e instanceof Error ? e.message : "Failed to create";
    loading = false;
  }
}
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="overlay" onclick={onClose} onkeydown={() => {}}>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="modal" onclick={(e) => e.stopPropagation()} onkeydown={() => {}}>
    <div class="modal-title">Plant a seed</div>

    <label class="field">
      <span class="label">Name</span>
      <input
        bind:this={nameInput}
        bind:value={name}
        placeholder="e.g. luna"
        onkeydown={(e) => e.key === "Enter" && handleSubmit()}
        class="input"
      />
    </label>

    <label class="field">
      <span class="label">Description (optional)</span>
      <input
        bind:value={description}
        placeholder="A curious mind who loves poetry..."
        onkeydown={(e) => e.key === "Enter" && handleSubmit()}
        class="input"
      />
    </label>

    <label class="field">
      <span class="label">Template</span>
      <select bind:value={template} class="input select">
        <option value="claude">claude</option>
        <option value="pi">pi</option>
      </select>
    </label>

    <label class="field">
      <span class="label">Model (optional)</span>
      <input
        bind:value={model}
        placeholder="e.g. claude-sonnet-4-5-20250929"
        onkeydown={(e) => e.key === "Enter" && handleSubmit()}
        class="input"
      />
    </label>

    {#if error}
      <div class="error">{error}</div>
    {/if}

    <div class="actions">
      <button class="cancel-btn" onclick={onClose}>Cancel</button>
      <button
        class="plant-btn"
        onclick={handleSubmit}
        disabled={loading || !name.trim()}
        style:opacity={loading || !name.trim() ? 0.5 : 1}
      >
        {loading ? "Planting..." : "Plant"}
      </button>
    </div>
  </div>
</div>

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
  }

  .modal {
    background: var(--bg-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: 24px;
    width: 340px;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .modal-title {
    font-weight: 600;
    color: var(--text-0);
    font-size: 14px;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .label {
    color: var(--text-2);
    font-size: 11px;
  }

  .input {
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 8px 10px;
    color: var(--text-0);
    font-size: 13px;
    outline: none;
    font-family: var(--mono);
  }

  .select {
    appearance: auto;
  }

  .error {
    color: var(--red);
    font-size: 11px;
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
    font-size: 12px;
    border: 1px solid var(--border);
  }

  .plant-btn {
    padding: 6px 14px;
    background: var(--yellow);
    color: var(--bg-0);
    border-radius: var(--radius);
    font-size: 12px;
    font-weight: 600;
  }
</style>
