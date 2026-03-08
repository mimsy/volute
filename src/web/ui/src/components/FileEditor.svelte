<script lang="ts">
import { fetchFile, fetchFiles } from "../lib/client";

let { name }: { name: string } = $props();

let files = $state<string[]>([]);
let selected = $state<string | null>(null);
let content = $state("");
let error = $state("");

$effect(() => {
  fetchFiles(name)
    .then((f) => {
      files = f;
      if (f.length > 0 && !selected) selected = f[0];
    })
    .catch(() => {
      error = "Failed to load files";
    });
});

$effect(() => {
  if (!selected) return;
  fetchFile(name, selected)
    .then((f) => {
      content = f.content;
      error = "";
    })
    .catch(() => {
      error = "Failed to load file";
    });
});
</script>

<div class="file-editor">
  <!-- File list sidebar -->
  <div class="sidebar">
    {#each files as f}
      <button
        class="file-item"
        class:active={f === selected}
        onclick={() => (selected = f)}
      >
        {f}
      </button>
    {/each}
  </div>

  <!-- Viewer -->
  <div class="viewer">
    {#if selected}
      <div class="viewer-header">
        <span class="filename">{selected}</span>
        {#if error}
          <span class="error">{error}</span>
        {/if}
      </div>
      <textarea
        value={content}
        readonly
        spellcheck="false"
        class="file-content"
      ></textarea>
    {/if}
  </div>
</div>

<style>
  .file-editor {
    display: flex;
    flex-direction: column;
    height: 100%;
    gap: 0;
  }

  .sidebar {
    flex-shrink: 0;
    border-bottom: 1px solid var(--border);
    padding: 4px 8px;
    overflow-x: auto;
    display: flex;
    flex-wrap: wrap;
    gap: 2px;
  }

  .file-item {
    padding: 4px 10px;
    text-align: left;
    background: transparent;
    color: var(--text-1);
    font-size: 13px;
    font-family: var(--mono);
    border-radius: 4px;
    transition: all 0.1s;
  }

  .file-item.active {
    background: var(--accent-bg);
    color: var(--accent);
  }

  .viewer {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .viewer-header {
    padding: 8px 12px;
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 13px;
  }

  .filename {
    color: var(--text-1);
  }

  .error {
    color: var(--red);
    font-size: 12px;
  }

  .file-content {
    flex: 1;
    padding: 12px;
    background: var(--bg-0);
    color: var(--text-0);
    font-family: var(--mono);
    font-size: 13px;
    line-height: 1.7;
    border: none;
    outline: none;
    resize: none;
    tab-size: 2;
  }
</style>
