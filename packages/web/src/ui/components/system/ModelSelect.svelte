<script lang="ts">
type Item = { id: string; label: string };

let {
  items,
  value = $bindable(""),
  placeholder = "Search models...",
  emptyLabel = "None",
}: {
  items: Item[];
  value?: string;
  placeholder?: string;
  emptyLabel?: string;
} = $props();

let query = $state("");
let open = $state(false);
let inputEl = $state<HTMLInputElement>();
let debounceTimer: ReturnType<typeof setTimeout>;

// Display the selected item's label when not searching
let displayValue = $derived(
  open ? query : (items.find((i) => i.id === value)?.label ?? (value ? value : "")),
);

let filtered = $derived.by(() => {
  const q = query.toLowerCase().trim();
  if (!q) return items;
  return items.filter((i) => i.id.toLowerCase().includes(q) || i.label.toLowerCase().includes(q));
});

function handleInput(e: Event) {
  const val = (e.target as HTMLInputElement).value;
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    query = val;
    open = true;
  }, 150);
}

function handleFocus() {
  query = "";
  open = true;
}

function handleBlur() {
  // Delay to allow click on option to register
  setTimeout(() => {
    open = false;
    query = "";
  }, 200);
}

function select(id: string) {
  value = id;
  open = false;
  query = "";
  inputEl?.blur();
}

function clear() {
  value = "";
  open = false;
  query = "";
}
</script>

<div class="model-select">
  <input
    bind:this={inputEl}
    type="text"
    class="text-input"
    value={displayValue}
    oninput={handleInput}
    onfocus={handleFocus}
    onblur={handleBlur}
    {placeholder}
  />
  {#if value && !open}
    <button class="clear-btn" onmousedown={(e) => { e.preventDefault(); clear(); }} type="button">×</button>
  {/if}
  {#if open}
    <div class="dropdown">
      {#if emptyLabel}
        <button
          class="dropdown-option"
          class:selected={!value}
          onmousedown={(e) => { e.preventDefault(); select(""); }}
          type="button"
        >
          <span class="option-empty">{emptyLabel}</span>
        </button>
      {/if}
      {#each filtered as item (item.id)}
        <button
          class="dropdown-option"
          class:selected={item.id === value}
          onmousedown={(e) => { e.preventDefault(); select(item.id); }}
          type="button"
        >
          {item.label}
        </button>
      {/each}
      {#if filtered.length === 0}
        <span class="dropdown-empty">No matches</span>
      {/if}
    </div>
  {/if}
</div>

<style>
  .model-select {
    position: relative;
  }

  .text-input {
    width: 100%;
    padding: 8px 28px 8px 10px;
    background: var(--bg-3);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--text-0);
    font-size: 13px;
    font-family: inherit;
    outline: none;
    box-sizing: border-box;
  }

  .text-input:focus {
    border-color: var(--border-bright);
  }

  .clear-btn {
    position: absolute;
    right: 6px;
    top: 50%;
    transform: translateY(-50%);
    background: none;
    border: none;
    color: var(--text-2);
    cursor: pointer;
    font-size: 14px;
    padding: 0 4px;
    line-height: 1;
  }

  .clear-btn:hover {
    color: var(--text-0);
  }

  .dropdown {
    position: absolute;
    top: 100%;
    left: 0;
    right: 0;
    z-index: 10;
    max-height: 220px;
    overflow-y: auto;
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-top: none;
    border-radius: 0 0 var(--radius) var(--radius);
  }

  .dropdown-option {
    display: block;
    width: 100%;
    padding: 7px 12px;
    font-size: 13px;
    font-family: inherit;
    background: none;
    border: none;
    border-bottom: 1px solid var(--border);
    color: var(--text-0);
    cursor: pointer;
    text-align: left;
  }

  .dropdown-option:last-child {
    border-bottom: none;
  }

  .dropdown-option:hover {
    background: var(--bg-3);
  }

  .dropdown-option.selected {
    color: var(--accent);
  }

  .option-empty {
    color: var(--text-2);
    font-style: italic;
  }

  .dropdown-empty {
    display: block;
    padding: 8px 12px;
    color: var(--text-2);
    font-size: 12px;
  }
</style>
