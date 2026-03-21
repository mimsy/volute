<script lang="ts">
import type { ToolGroup } from "../lib/tool-groups";
import { getCategoryColor, getToolLabel } from "../lib/tool-names";

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

let categoryColor = $derived(getCategoryColor(group.category));

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

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="tool-group"
  class:expanded
  style:--cat-color={categoryColor}
  onclick={() => { expanded = !expanded; }}
  onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); expanded = !expanded; } }}
>
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
  {:else}
    <span class="inline-label">
      {label}
      {#if isRunning}
        <span class="status-running">running...</span>
      {:else if isError}
        <span class="status-error">error</span>
      {/if}
    </span>
  {/if}
</div>

<style>
  .tool-group {
    cursor: pointer;
  }

  /* Collapsed: inline text */
  .inline-label {
    font-family: var(--mono);
    font-size: 13px;
    color: var(--cat-color);
    line-height: 1.5;
    display: -webkit-box;
    -webkit-line-clamp: 4;
    -webkit-box-orient: vertical;
    overflow: hidden;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .status-running {
    color: var(--yellow);
    font-size: 11px;
    margin-left: 6px;
    animation: pulse 1.5s infinite;
  }

  .status-error {
    color: var(--red);
    font-size: 11px;
    margin-left: 6px;
  }

  /* Expanded: card with content */
  .tool-group.expanded {
    border: 1px solid color-mix(in srgb, var(--cat-color) 25%, var(--border));
    border-radius: var(--radius-lg);
    overflow: hidden;
    background: var(--bg-0);
  }

  /* Terminal style for shell commands */
  .terminal {
    background: #0d0d0d;
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
