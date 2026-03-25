<script lang="ts">
import { Modal } from "@volute/ui";
import { onMount } from "svelte";
import { type ContextBreakdown, type ContextInfo, fetchMindContext } from "../../lib/client";

let { mindName, onClose }: { mindName: string; onClose: () => void } = $props();

let contextInfo = $state<ContextInfo | null>(null);
let loading = $state(true);
let error = $state("");
let hoveredCategory = $state<string | null>(null);

onMount(async () => {
  try {
    contextInfo = await fetchMindContext(mindName);
  } catch (e: any) {
    error = e.message ?? "Failed to fetch context info";
  } finally {
    loading = false;
  }
});

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

type Category = { key: string; label: string; tokens: number; color: string };

const COLORS = {
  systemPrompt: "#6366f1",
  claudeMd: "#818cf8",
  skillDesc: "#8b5cf6",
  userText: "#3b82f6",
  assistantText: "#22c55e",
  thinking: "#f59e0b",
  toolUse: "#ec4899",
  toolResult: "#f97316",
  sdk: "#64748b",
  empty: "var(--bg-3, #2a2a2a)",
};

function getCategories(breakdown: ContextBreakdown, contextTokens: number): Category[] {
  const cats: Category[] = [
    {
      key: "systemPrompt",
      label: "System Prompt",
      tokens: breakdown.systemPrompt,
      color: COLORS.systemPrompt,
    },
    { key: "claudeMd", label: "CLAUDE.md", tokens: breakdown.claudeMd, color: COLORS.claudeMd },
    {
      key: "skillDesc",
      label: "Skill Descriptions",
      tokens: breakdown.skillDescriptions,
      color: COLORS.skillDesc,
    },
    {
      key: "userText",
      label: "User Messages",
      tokens: breakdown.conversation.userText,
      color: COLORS.userText,
    },
    {
      key: "assistantText",
      label: "Assistant Text",
      tokens: breakdown.conversation.assistantText,
      color: COLORS.assistantText,
    },
    {
      key: "thinking",
      label: "Thinking",
      tokens: breakdown.conversation.thinking,
      color: COLORS.thinking,
    },
    {
      key: "toolUse",
      label: "Tool Calls",
      tokens: breakdown.conversation.toolUse,
      color: COLORS.toolUse,
    },
    {
      key: "toolResult",
      label: "Tool Results",
      tokens: breakdown.conversation.toolResult,
      color: COLORS.toolResult,
    },
  ].filter((c) => c.tokens > 0);

  const counted = cats.reduce((s, c) => s + c.tokens, 0);
  const sdk = contextTokens - counted;
  if (sdk > 0) {
    cats.push({ key: "sdk", label: "Tools & SDK", tokens: sdk, color: COLORS.sdk });
  }
  return cats;
}

const GRID_COLS = 15;
const TOKENS_PER_CELL = 2000;

function buildGrid(
  categories: Category[],
  contextWindow: number,
): { color: string; category: string }[] {
  const totalCells = Math.ceil(contextWindow / TOKENS_PER_CELL);
  // Round up to full row
  const rows = Math.ceil(totalCells / GRID_COLS);
  const gridCells = rows * GRID_COLS;

  const cells: { color: string; category: string }[] = [];
  for (const cat of categories) {
    const count = Math.max(1, Math.round(cat.tokens / TOKENS_PER_CELL));
    for (let i = 0; i < count && cells.length < gridCells; i++) {
      cells.push({ color: cat.color, category: cat.key });
    }
  }
  // Fill remaining with empty (unused context)
  while (cells.length < gridCells) {
    cells.push({ color: COLORS.empty, category: "empty" });
  }
  return cells;
}
</script>

<Modal title="Context — {mindName}" {onClose} size="600px">
  {#if loading}
    <div class="loading">Loading context info...</div>
  {:else if error}
    <div class="error">{error}</div>
  {:else if contextInfo}
    <div class="context-content">
      {#if contextInfo.systemPrompt > 0}
        <div class="system-prompt-line">
          <span class="sp-label">System prompt</span>
          <span class="sp-value">{formatTokens(contextInfo.systemPrompt)} tokens</span>
        </div>
      {/if}

      {#if contextInfo.sessions.length === 0}
        <div class="empty">No active sessions</div>
      {:else}
        <div class="sessions">
          {#each contextInfo.sessions as session (session.name)}
            {@const categories = session.breakdown ? getCategories(session.breakdown, session.contextTokens) : []}
            {@const cells = categories.length > 0 && session.contextWindow ? buildGrid(categories, session.contextWindow) : []}
            {@const overLimit = session.contextWindow ? session.contextTokens > session.contextWindow : false}

            <div class="session-block">
              <div class="session-header">
                <span class="session-name">{session.name}</span>
                <span class="session-tokens">
                  {#if session.contextTokens > 0}
                    <span class:over-limit={overLimit}>{formatTokens(session.contextTokens)}</span>{#if session.contextWindow}&nbsp;/&nbsp;{formatTokens(session.contextWindow)}{/if}
                  {:else}
                    <span class="no-data">no data yet</span>
                  {/if}
                </span>
              </div>

              {#if cells.length > 0}
                <!-- Waffle chart -->
                <!-- svelte-ignore a11y_no_static_element_interactions -->
                <div
                  class="waffle"
                  style:grid-template-columns="repeat({GRID_COLS}, 1fr)"
                  onmouseleave={() => hoveredCategory = null}
                >
                  {#each cells as cell, i (i)}
                    <!-- svelte-ignore a11y_no_static_element_interactions -->
                    <div
                      class="cell"
                      class:dimmed={hoveredCategory !== null && cell.category !== hoveredCategory}
                      class:highlighted={hoveredCategory === cell.category}
                      style:background={cell.color}
                      onmouseenter={() => { if (cell.category !== "empty") hoveredCategory = cell.category; }}
                    ></div>
                  {/each}
                </div>

                <!-- Hover legend -->
                {#if hoveredCategory}
                  {@const cat = categories.find(c => c.key === hoveredCategory)}
                  {#if cat}
                    <div class="hover-legend">
                      <span class="legend-dot" style:background={cat.color}></span>
                      <span class="legend-label">{cat.label}</span>
                      <span class="legend-value">{formatTokens(cat.tokens)}</span>
                    </div>
                  {/if}
                {:else}
                  <div class="hover-legend hint">hover for details</div>
                {/if}
              {:else if session.contextTokens > 0}
                <!-- Simple bar fallback -->
                <div class="token-bar">
                  <div
                    class="token-bar-fill"
                    style:width="{Math.min(100, (session.contextTokens / (session.contextWindow ?? session.contextTokens)) * 100)}%"
                  ></div>
                </div>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
    </div>
  {/if}
</Modal>

<style>
  .loading, .error, .empty {
    padding: 24px;
    text-align: center;
    color: var(--text-2);
    font-size: 13px;
  }

  .error {
    color: var(--danger, #e53e3e);
  }

  .context-content {
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .system-prompt-line {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 12px;
    color: var(--text-2);
    padding: 0 4px;
  }

  .sp-label {
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-weight: 600;
    font-size: 11px;
  }

  .sp-value {
    font-variant-numeric: tabular-nums;
  }

  /* Sessions */

  .sessions {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 16px;
  }

  .session-block {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .session-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 12px;
  }

  .session-name {
    color: var(--text-1);
    font-weight: 500;
  }

  .session-tokens {
    color: var(--text-2);
    font-variant-numeric: tabular-nums;
  }

  .no-data {
    color: var(--text-3);
    font-style: italic;
  }

  .over-limit {
    color: var(--danger, #e53e3e);
  }

  /* Waffle chart */

  .waffle {
    display: grid;
    gap: 1px;
  }

  .cell {
    aspect-ratio: 1;
    border-radius: 2px;
    transition: opacity 0.15s ease;
  }

  .cell.dimmed {
    opacity: 0.2;
  }

  .cell.highlighted {
    opacity: 1;
    box-shadow: 0 0 0 1px rgba(255,255,255,0.3);
  }

  /* Hover legend */

  .hover-legend {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    height: 18px;
  }

  .hover-legend.hint {
    color: var(--text-3);
    font-style: italic;
  }

  .legend-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .legend-label {
    color: var(--text-1);
  }

  .legend-value {
    color: var(--text-2);
    font-variant-numeric: tabular-nums;
  }

  /* Simple bar fallback */

  .token-bar {
    height: 4px;
    background: var(--bg-2);
    border-radius: 2px;
    overflow: hidden;
  }

  .token-bar-fill {
    height: 100%;
    background: var(--accent);
    border-radius: 2px;
    transition: width 0.3s ease;
  }
</style>
