<script lang="ts">
import type { ToolGroup } from "../lib/tool-groups";
import { getToolLabel } from "../lib/tool-names";

let {
  group,
  turnStatus = "complete",
}: {
  group: ToolGroup;
  mindName: string;
  compact?: boolean;
  turnStatus?: string;
} = $props();

let expanded = $state(false);

let meta = $derived.by(() => {
  if (!group.toolUse.metadata) return null;
  try {
    return JSON.parse(group.toolUse.metadata) as Record<string, unknown>;
  } catch {
    return null;
  }
});

let resultMeta = $derived.by(() => {
  if (!group.toolResult?.metadata) return null;
  try {
    return JSON.parse(group.toolResult.metadata) as Record<string, unknown>;
  } catch {
    return null;
  }
});

let isError = $derived(!!resultMeta?.is_error);
let isRunning = $derived(!group.toolResult && turnStatus === "active");
let label = $derived(getToolLabel((meta?.name as string) ?? "tool", group.toolUse.content));

let categoryColor = $derived.by(() => {
  switch (group.category) {
    case "shell":
      return "var(--red)";
    case "file":
      return "var(--blue)";
    case "search":
      return "var(--yellow)";
    case "web":
      return "var(--purple)";
    default:
      return "var(--text-1)";
  }
});

function formatOutput(content: string): string {
  if (!content) return "";
  // Strip volute correlation markers
  return content.replace(/\[volute:[^\]]*\]\s*/g, "");
}

function formatArgs(args: unknown): string {
  if (typeof args === "string") {
    try {
      return JSON.stringify(JSON.parse(args), null, 2);
    } catch {
      return args;
    }
  }
  return JSON.stringify(args, null, 2);
}
</script>

<div class="tool-group" class:expanded class:error={isError}>
  <button class="tool-group-header" onclick={() => { expanded = !expanded; }} style:--cat-color={categoryColor}>
    <span class="tool-icon">
      {#if group.category === "shell"}
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5l4 3-4 3"/><path d="M9 12h4"/></svg>
      {:else if group.category === "file"}
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 2h6l4 4v8H4V2z"/><path d="M10 2v4h4"/></svg>
      {:else if group.category === "search"}
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="7" cy="7" r="4"/><path d="M10 10l3 3"/></svg>
      {:else if group.category === "web"}
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6"/><path d="M2 8h12"/><path d="M8 2c2 2 3 4 3 6s-1 4-3 6"/><path d="M8 2c-2 2-3 4-3 6s1 4 3 6"/></svg>
      {:else}
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="10" height="10" rx="1"/><path d="M6 6h4M6 8h4M6 10h2"/></svg>
      {/if}
    </span>
    <span class="tool-label">{label}</span>
    <span class="tool-status">
      {#if isRunning}
        <span class="status-running">running...</span>
      {:else if isError}
        <span class="status-error">error</span>
      {:else if group.toolResult}
        <span class="status-done">done</span>
      {/if}
    </span>
    <span class="chevron">{expanded ? "▼" : "▶"}</span>
  </button>

  {#if expanded}
    <div class="tool-group-body">
      {#if group.category === "shell"}
        <div class="shell-block">
          {#if isRunning}
            <div class="shell-running">running...</div>
          {:else if group.toolResult}
            <pre class="shell-output" class:error={isError}>{formatOutput(group.toolResult.content)}</pre>
          {/if}
        </div>
      {:else if group.category === "file" || group.category === "search"}
        {#if group.toolUse.content}
          <div class="section-label">input</div>
          <pre class="tool-pre">{formatArgs(group.toolUse.content)}</pre>
        {/if}
        {#if isRunning}
          <div class="shell-running">running...</div>
        {:else if group.toolResult}
          <div class="section-label">output</div>
          <pre class="tool-pre tool-output" class:error={isError}>{formatOutput(group.toolResult.content)}</pre>
        {/if}
      {:else}
        {#if group.toolUse.content}
          <div class="section-label">input</div>
          <pre class="tool-pre">{formatArgs(group.toolUse.content)}</pre>
        {/if}
        {#if isRunning}
          <div class="shell-running">running...</div>
        {:else if group.toolResult}
          <div class="section-label">output</div>
          <pre class="tool-pre tool-output" class:error={isError}>{formatOutput(group.toolResult.content)}</pre>
        {/if}
      {/if}
    </div>
  {/if}
</div>

<style>
  .tool-group {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow: hidden;
    margin: 2px 0;
  }

  .tool-group-header {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    background: var(--bg-3);
    font-size: 13px;
    font-family: var(--mono);
    text-align: left;
    color: var(--cat-color);
    cursor: pointer;
    border: none;
  }

  .tool-group-header:hover {
    background: var(--bg-2);
  }

  .tool-icon {
    flex-shrink: 0;
    width: 14px;
    height: 14px;
    display: flex;
    align-items: center;
  }

  .tool-icon svg {
    width: 14px;
    height: 14px;
  }

  .tool-label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .tool-status {
    flex-shrink: 0;
    font-size: 11px;
  }

  .status-running {
    color: var(--yellow);
    animation: pulse 1.5s infinite;
  }

  .status-error {
    color: var(--red);
  }

  .status-done {
    color: var(--accent);
  }

  .chevron {
    font-size: 9px;
    color: var(--text-2);
    flex-shrink: 0;
  }

  .tool-group-body {
    padding: 8px;
    background: var(--bg-1);
    border-top: 1px solid var(--border);
  }

  .section-label {
    font-size: 11px;
    color: var(--text-2);
    margin-bottom: 4px;
    margin-top: 6px;
  }

  .section-label:first-child {
    margin-top: 0;
  }

  .shell-block {
    background: var(--bg-0);
    border-radius: var(--radius);
  }

  .shell-output {
    font-family: var(--mono);
    font-size: 12px;
    line-height: 1.5;
    color: var(--text-0);
    white-space: pre-wrap;
    word-break: break-all;
    max-height: 300px;
    overflow: auto;
    margin: 0;
  }

  .shell-output.error {
    color: var(--red);
  }

  .shell-running {
    font-size: 12px;
    color: var(--text-2);
    font-style: italic;
    padding: 4px 0;
    animation: pulse 1.5s infinite;
  }

  .tool-pre {
    font-family: var(--mono);
    font-size: 12px;
    line-height: 1.5;
    color: var(--text-1);
    white-space: pre-wrap;
    word-break: break-all;
    margin: 0;
    max-height: 300px;
    overflow: auto;
  }

  .tool-output {
    color: var(--text-0);
  }

  .tool-output.error {
    color: var(--red);
  }
</style>
