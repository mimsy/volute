<script lang="ts">
let {
  name: toolName,
  input: toolInput,
  output: toolOutput,
  isError = false,
  isOpen = false,
  onToggle,
}: {
  name: string;
  input: unknown;
  output?: string;
  isError?: boolean;
  isOpen: boolean;
  onToggle: () => void;
} = $props();

function getToolSummary(): { label: string; color: string } {
  const inp = toolInput as Record<string, unknown>;
  switch (toolName) {
    case "Read":
      return { label: `Read ${inp.file_path ?? ""}`, color: "var(--blue)" };
    case "Write":
      return { label: `Write ${inp.file_path ?? ""}`, color: "var(--blue)" };
    case "Edit":
      return { label: `Edit ${inp.file_path ?? ""}`, color: "var(--blue)" };
    case "Glob":
      return { label: `Glob ${inp.pattern ?? ""}`, color: "var(--yellow)" };
    case "Grep":
      return {
        label: `Grep "${inp.pattern ?? ""}"${inp.path ? ` in ${inp.path}` : ""}`,
        color: "var(--yellow)",
      };
    case "Bash":
      return {
        label: `Bash: ${String(inp.command ?? "").split("\n")[0]}`,
        color: "var(--red)",
      };
    case "WebSearch":
      return { label: `Search: "${inp.query ?? ""}"`, color: "var(--purple)" };
    case "WebFetch":
      return { label: `Fetch: ${inp.url ?? ""}`, color: "var(--purple)" };
    case "Task":
      return { label: `Task: ${inp.description ?? ""}`, color: "var(--accent)" };
    default:
      return { label: toolName, color: "var(--purple)" };
  }
}

let summary = $derived(getToolSummary());
</script>

<div class="tool-block">
  <button class="tool-header" onclick={onToggle} style:color={summary.color}>
    <span class="tool-label">
      <span class="tool-arrow">{isOpen ? "\u25BE" : "\u25B8"}</span>
      {summary.label}
    </span>
    {#if toolOutput !== undefined}
      <span class="tool-status" class:error={isError}>
        {isError ? "error" : "done"}
      </span>
    {/if}
  </button>
  {#if isOpen}
    <div class="tool-detail">
      <div class="tool-section-label">input:</div>
      <pre class="tool-pre">{JSON.stringify(toolInput, null, 2)}</pre>
      {#if toolOutput !== undefined}
        <div class="tool-section-label" style="margin-top: 8px">output:</div>
        <pre class="tool-pre tool-output" class:error={isError}>{toolOutput}</pre>
      {/if}
    </div>
  {/if}
</div>

<style>
  .tool-block {
    margin-bottom: 8px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow: hidden;
    font-size: 12px;
  }

  .tool-header {
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 10px;
    background: var(--bg-3);
    font-size: 12px;
    font-family: var(--mono);
    text-align: left;
  }

  .tool-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    min-width: 0;
  }

  .tool-arrow {
    color: var(--text-2);
    margin-right: 6px;
  }

  .tool-status {
    color: var(--accent);
    font-size: 10px;
    flex-shrink: 0;
    margin-left: 8px;
  }

  .tool-status.error {
    color: var(--red);
  }

  .tool-detail {
    padding: 10px;
    background: var(--bg-1);
  }

  .tool-section-label {
    margin-bottom: 6px;
    color: var(--text-2);
  }

  .tool-pre {
    color: var(--text-1);
    white-space: pre-wrap;
    word-break: break-all;
    font-size: 11px;
    line-height: 1.5;
  }

  .tool-output {
    max-height: 200px;
    overflow: auto;
  }

  .tool-output.error {
    color: var(--red);
  }
</style>
