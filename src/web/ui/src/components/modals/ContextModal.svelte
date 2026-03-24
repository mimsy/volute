<script lang="ts">
import { Modal } from "@volute/ui";
import { onMount } from "svelte";
import { type ContextBreakdown, type ContextInfo, fetchMindContext } from "../../lib/client";

let { mindName, onClose }: { mindName: string; onClose: () => void } = $props();

let contextInfo = $state<ContextInfo | null>(null);
let loading = $state(true);
let error = $state("");

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

type Segment = { label: string; tokens: number; color: string };

function getSegments(breakdown: ContextBreakdown): Segment[] {
  return [
    { label: "System Prompt", tokens: breakdown.systemPrompt, color: "var(--ctx-system, #6366f1)" },
    { label: "Skills", tokens: breakdown.skills, color: "var(--ctx-skills, #8b5cf6)" },
    {
      label: "User Messages",
      tokens: breakdown.conversation.userText,
      color: "var(--ctx-user, #3b82f6)",
    },
    {
      label: "Assistant Text",
      tokens: breakdown.conversation.assistantText,
      color: "var(--ctx-assistant, #22c55e)",
    },
    {
      label: "Thinking",
      tokens: breakdown.conversation.thinking,
      color: "var(--ctx-thinking, #f59e0b)",
    },
    {
      label: "Tool Calls",
      tokens: breakdown.conversation.toolUse,
      color: "var(--ctx-tool-use, #ec4899)",
    },
    {
      label: "Tool Results",
      tokens: breakdown.conversation.toolResult,
      color: "var(--ctx-tool-result, #f97316)",
    },
  ].filter((s) => s.tokens > 0);
}
</script>

<Modal title="Context — {mindName}" {onClose} size="520px">
  {#if loading}
    <div class="loading">Loading context info...</div>
  {:else if error}
    <div class="error">{error}</div>
  {:else if contextInfo}
    <div class="context-content">
      <section class="section">
        <h3 class="section-title">System Prompt</h3>
        <div class="estimate-note">Estimated from file sizes</div>
        <div class="breakdown">
          <div class="breakdown-row">
            <span class="label">SOUL.md</span>
            <span class="value">{formatTokens(contextInfo.systemPrompt.components.soul)}</span>
          </div>
          {#if contextInfo.systemPrompt.components.volute > 0}
            <div class="breakdown-row">
              <span class="label">VOLUTE.md</span>
              <span class="value">{formatTokens(contextInfo.systemPrompt.components.volute)}</span>
            </div>
          {/if}
          {#if contextInfo.systemPrompt.components.memory > 0}
            <div class="breakdown-row">
              <span class="label">MEMORY.md</span>
              <span class="value">{formatTokens(contextInfo.systemPrompt.components.memory)}</span>
            </div>
          {/if}
          <div class="breakdown-row total">
            <span class="label">Total</span>
            <span class="value">{formatTokens(contextInfo.systemPrompt.total)}</span>
          </div>
        </div>
      </section>

      {#if contextInfo.skills && contextInfo.skills.items.length > 0}
        <section class="section">
          <h3 class="section-title">Skills</h3>
          <div class="breakdown">
            {#each contextInfo.skills.items as skill (skill.name)}
              <div class="breakdown-row">
                <span class="label">{skill.name}</span>
                <span class="value">{formatTokens(skill.tokens)}</span>
              </div>
            {/each}
            <div class="breakdown-row total">
              <span class="label">Total</span>
              <span class="value">{formatTokens(contextInfo.skills.total)}</span>
            </div>
          </div>
        </section>
      {/if}

      <section class="section">
        <h3 class="section-title">Sessions</h3>
        {#if contextInfo.sessions.length === 0}
          <div class="empty">No active sessions</div>
        {:else}
          <div class="sessions">
            {#each contextInfo.sessions as session (session.name)}
              {@const contextWindow = session.contextWindow ?? 200000}
              {@const segments = session.breakdown ? getSegments(session.breakdown) : []}
              {@const segmentTotal = segments.reduce((sum, s) => sum + s.tokens, 0)}

              <div class="session-block">
                <div class="session-header">
                  <span class="session-name">{session.name}</span>
                  <span class="session-tokens">
                    {#if session.contextTokens > 0}
                      {formatTokens(session.contextTokens)}{#if session.contextWindow}&nbsp;/&nbsp;{formatTokens(session.contextWindow)}{/if}
                    {:else}
                      <span class="no-data">no data yet</span>
                    {/if}
                  </span>
                </div>

                {#if session.contextTokens > 0}
                  {#if segments.length > 0}
                    <!-- Stacked breakdown bar -->
                    <div class="stacked-bar" title="{formatTokens(session.contextTokens)} tokens used">
                      {#each segments as seg}
                        <div
                          class="stacked-segment"
                          style:width="{Math.max(1, (seg.tokens / contextWindow) * 100)}%"
                          style:background={seg.color}
                          title="{seg.label}: {formatTokens(seg.tokens)}"
                        ></div>
                      {/each}
                    </div>

                    <!-- Legend -->
                    <div class="legend">
                      {#each segments as seg}
                        <div class="legend-item">
                          <span class="legend-dot" style:background={seg.color}></span>
                          <span class="legend-label">{seg.label}</span>
                          <span class="legend-value">{formatTokens(seg.tokens)}</span>
                        </div>
                      {/each}
                      {#if segmentTotal < session.contextTokens}
                        {@const other = session.contextTokens - segmentTotal}
                        <div class="legend-item">
                          <span class="legend-dot" style:background="var(--text-3)"></span>
                          <span class="legend-label">Other</span>
                          <span class="legend-value">{formatTokens(other)}</span>
                        </div>
                      {/if}
                    </div>
                  {:else}
                    <!-- Simple bar when no breakdown available -->
                    <div class="token-bar">
                      <div class="token-bar-fill" style:width="{Math.min(100, (session.contextTokens / contextWindow) * 100)}%"></div>
                    </div>
                  {/if}
                {/if}
              </div>
            {/each}
          </div>
        {/if}
      </section>
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
    gap: 20px;
  }

  .section {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .section-title {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-2);
    margin: 0;
  }

  .estimate-note {
    font-size: 11px;
    color: var(--text-3);
    font-style: italic;
  }

  .breakdown {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .breakdown-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 4px 8px;
    border-radius: var(--radius, 4px);
    font-size: 13px;
  }

  .breakdown-row.total {
    border-top: 1px solid var(--border);
    margin-top: 4px;
    padding-top: 8px;
    font-weight: 600;
  }

  .label {
    color: var(--text-1);
  }

  .value {
    color: var(--text-2);
    font-variant-numeric: tabular-nums;
  }

  /* Sessions */

  .sessions {
    display: flex;
    flex-direction: column;
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
    font-size: 13px;
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

  /* Stacked breakdown bar */

  .stacked-bar {
    display: flex;
    height: 8px;
    border-radius: 4px;
    overflow: hidden;
    background: var(--bg-2);
    gap: 1px;
  }

  .stacked-segment {
    height: 100%;
    min-width: 2px;
    transition: width 0.3s ease;
  }

  .stacked-segment:first-child {
    border-radius: 4px 0 0 4px;
  }

  .stacked-segment:last-child {
    border-radius: 0 4px 4px 0;
  }

  /* Legend */

  .legend {
    display: flex;
    flex-wrap: wrap;
    gap: 2px 12px;
  }

  .legend-item {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
  }

  .legend-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .legend-label {
    color: var(--text-2);
  }

  .legend-value {
    color: var(--text-3);
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
