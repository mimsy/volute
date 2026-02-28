<script lang="ts">
import type { ContentBlock, Mind } from "@volute/api";
import { renderMarkdown } from "../lib/markdown";
import MindHoverCard from "./MindHoverCard.svelte";
import ToolBlock from "./ToolBlock.svelte";

type ToolInfo = {
  name: string;
  input: unknown;
  output?: string;
  isError?: boolean;
};

let {
  role,
  blocks,
  senderName,
  createdAt,
  showHeader = true,
  senderColor = "var(--text-0)",
  entryIndex,
  openTools,
  onToggleTool,
  mindsByName,
  onOpenMind,
}: {
  role: "user" | "assistant";
  blocks: ContentBlock[];
  senderName?: string;
  createdAt?: string;
  showHeader?: boolean;
  senderColor?: string;
  entryIndex: number;
  openTools: Set<number>;
  onToggleTool: (key: number) => void;
  mindsByName: Map<string, Mind>;
  onOpenMind?: (mind: Mind) => void;
} = $props();

function formatTime(dateStr?: string): string {
  if (!dateStr) return "";
  try {
    const d = new Date(dateStr.endsWith("Z") ? dateStr : `${dateStr}Z`);
    return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  } catch {
    return "";
  }
}

function buildAssistantItems(
  blocks: ContentBlock[],
): Array<
  | { kind: "text"; text: string }
  | { kind: "tool"; tool: ToolInfo }
  | { kind: "image"; media_type: string; data: string }
> {
  const items: Array<
    | { kind: "text"; text: string }
    | { kind: "tool"; tool: ToolInfo }
    | { kind: "image"; media_type: string; data: string }
  > = [];

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (block.type === "text") {
      items.push({ kind: "text", text: block.text });
    } else if (block.type === "tool_use") {
      const tool: ToolInfo = { name: block.name, input: block.input };
      const next = blocks[i + 1];
      if (next && next.type === "tool_result") {
        tool.output = next.output;
        tool.isError = next.is_error;
        i++;
      }
      items.push({ kind: "tool", tool });
    } else if (block.type === "tool_result") {
      // Orphaned tool_result — skip
    } else if (block.type === "image") {
      items.push({ kind: "image", media_type: block.media_type, data: block.data });
    }
  }
  return items;
}
</script>

<div class="entry" class:new-sender={showHeader}>
  {#if showHeader}
    <div class="entry-header">
      {#if senderName && mindsByName.has(senderName) && onOpenMind}
        {@const senderMind = mindsByName.get(senderName)!}
        <MindHoverCard mind={senderMind}>
          {#snippet children()}
            <button class="sender sender-link" style:color={senderColor} onclick={() => onOpenMind(senderMind)}>{senderMind.displayName ?? senderName}</button>
          {/snippet}
        </MindHoverCard>
      {:else}
        <span class="sender" style:color={senderColor}>{senderName || (role === "user" ? "you" : "mind")}</span>
      {/if}
      {#if createdAt}
        <span class="timestamp">{formatTime(createdAt)}</span>
      {/if}
    </div>
  {/if}
  <div class="entry-content">
    {#if role === "user"}
      {#each blocks as block}
        {#if block.type === "text"}
          <div class="user-text">{block.text}</div>
        {:else if block.type === "image"}
          <img src={`data:${block.media_type};base64,${block.data}`} alt="" class="chat-image" />
        {/if}
      {/each}
    {:else}
      {@const items = buildAssistantItems(blocks)}
      {#each items as item, j}
        {#if item.kind === "text"}
          <div class="markdown-body">{@html renderMarkdown(item.text)}</div>
        {:else if item.kind === "tool"}
          {@const toolKey = entryIndex * 1000 + j}
          <ToolBlock
            name={item.tool.name}
            input={item.tool.input}
            output={item.tool.output}
            isError={item.tool.isError ?? false}
            isOpen={openTools.has(toolKey)}
            onToggle={() => onToggleTool(toolKey)}
          />
        {:else if item.kind === "image"}
          <img src={`data:${item.media_type};base64,${item.data}`} alt="" class="chat-image" />
        {/if}
      {/each}
    {/if}
  </div>
</div>

<style>
  .entry {
    padding: 2px 0;
    animation: fadeIn 0.2s ease both;
  }

  .entry.new-sender {
    margin-top: 12px;
  }

  .entry-header {
    display: flex;
    align-items: baseline;
    gap: 8px;
    margin-bottom: 2px;
  }

  .sender {
    font-size: 13px;
    font-weight: 600;
  }

  .sender-link {
    background: none;
    border: none;
    padding: 0;
    font: inherit;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
  }

  .sender-link:hover {
    text-decoration: underline;
  }

  .timestamp {
    font-size: 11px;
    color: var(--text-2);
  }

  .entry-content {
    min-width: 0;
  }

  .user-text {
    color: var(--text-0);
    white-space: pre-wrap;
  }

  .chat-image {
    max-width: 300px;
    max-height: 200px;
    border-radius: var(--radius);
    margin-top: 4px;
  }
</style>
