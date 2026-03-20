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

let shellCommand = $derived.by(() => {
  if (group.category !== "shell") return "";
  try {
    const args = JSON.parse(group.toolUse.content);
    return String(args.command ?? "");
  } catch {
    return group.toolUse.content ?? "";
  }
});

function formatOutput(content: string): string {
  if (!content) return "";
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

<div class="tool-card" style:--cat-color={categoryColor}>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="tool-card-header" onclick={() => { expanded = !expanded; }} onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); expanded = !expanded; } }}>
    <span class="tool-card-icon">
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
    <span class="tool-card-label">{label}</span>
    <span class="tool-card-status">
      {#if isRunning}
        <span class="status-running">running...</span>
      {:else if isError}
        <span class="status-error">error</span>
      {:else if group.toolResult}
        <span class="status-done">done</span>
      {/if}
    </span>
    <span class="chevron">{expanded ? "▼" : "▶"}</span>
  </div>

  {#if expanded}
    {#if group.category === "shell"}
      <div class="terminal">
        <div class="terminal-cmd"><span class="terminal-prompt">$</span> {shellCommand}</div>
        {#if isRunning}
          <div class="terminal-running">running...</div>
        {:else if group.toolResult}
          <pre class="terminal-output" class:error={isError}>{formatOutput(group.toolResult.content)}</pre>
        {/if}
      </div>
    {:else}
      <div class="tool-card-body">
        {#if group.toolUse.content}
          <div class="section-label">input</div>
          <pre class="tool-pre">{formatArgs(group.toolUse.content)}</pre>
        {/if}
        {#if isRunning}
          <div class="terminal-running">running...</div>
        {:else if group.toolResult}
          <div class="section-label">output</div>
          <pre class="tool-pre tool-output" class:error={isError}>{formatOutput(group.toolResult.content)}</pre>
        {/if}
      </div>
    {/if}
  {/if}
</div>

<style>
  .tool-card {
    border: 1px solid color-mix(in srgb, var(--cat-color) 25%, var(--border));
    border-radius: var(--radius-lg);
    overflow: hidden;
    margin: 2px 0;
    background: var(--bg-0);
  }

  .tool-card-header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    font-size: 13px;
    font-weight: 500;
    color: var(--text-1);
    cursor: pointer;
  }

  .tool-card-header:hover {
    background: var(--bg-3);
  }

  .tool-card-icon {
    flex-shrink: 0;
    width: 12px;
    height: 12px;
    color: var(--cat-color);
    display: flex;
    align-items: center;
  }

  .tool-card-icon svg {
    width: 12px;
    height: 12px;
  }

  .tool-card-label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--mono);
    font-weight: 400;
    color: var(--cat-color);
  }

  .tool-card-status {
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

  /* Terminal style for shell commands */
  .terminal {
    background: #0d0d0d;
    border-top: 1px solid color-mix(in srgb, var(--cat-color) 25%, var(--border));
    padding: 8px 10px;
    font-family: var(--mono);
    font-size: 12px;
    line-height: 1.6;
    max-height: 200px;
    overflow: auto;
  }

  .terminal-cmd {
    color: #e0e0e0;
    white-space: pre-wrap;
    word-break: break-all;
  }

  .terminal-prompt {
    color: var(--accent);
    margin-right: 6px;
    user-select: none;
  }

  .terminal-output {
    color: #a0a0a0;
    white-space: pre-wrap;
    word-break: break-all;
    margin: 4px 0 0 0;
  }

  .terminal-output.error {
    color: var(--red);
  }

  .terminal-running {
    color: var(--text-2);
    font-style: italic;
    padding: 4px 0;
    animation: pulse 1.5s infinite;
  }

  /* Generic tool body */
  .tool-card-body {
    border-top: 1px solid color-mix(in srgb, var(--cat-color) 25%, var(--border));
    padding: 8px;
    max-height: 200px;
    overflow: auto;
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

  .tool-pre {
    font-family: var(--mono);
    font-size: 12px;
    line-height: 1.5;
    color: var(--text-1);
    white-space: pre-wrap;
    word-break: break-all;
    margin: 0;
  }

  .tool-output {
    color: var(--text-0);
  }

  .tool-output.error {
    color: var(--red);
  }
</style>
