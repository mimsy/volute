<script lang="ts">
import { Modal } from "@volute/ui";
import { onMount } from "svelte";
import { type ContextInfo, fetchMindContext } from "../../lib/client";

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
</script>

<Modal title="Context — {mindName}" {onClose} size="480px">
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
            <span class="value">{formatTokens(contextInfo.systemPrompt.components.soul)} tokens</span>
          </div>
          {#if contextInfo.systemPrompt.components.volute > 0}
            <div class="breakdown-row">
              <span class="label">VOLUTE.md</span>
              <span class="value">{formatTokens(contextInfo.systemPrompt.components.volute)} tokens</span>
            </div>
          {/if}
          {#if contextInfo.systemPrompt.components.memory > 0}
            <div class="breakdown-row">
              <span class="label">MEMORY.md</span>
              <span class="value">{formatTokens(contextInfo.systemPrompt.components.memory)} tokens</span>
            </div>
          {/if}
          <div class="breakdown-row total">
            <span class="label">Total</span>
            <span class="value">{formatTokens(contextInfo.systemPrompt.total)} tokens</span>
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
                <span class="value">{formatTokens(skill.tokens)} tokens</span>
              </div>
            {/each}
            <div class="breakdown-row total">
              <span class="label">Total</span>
              <span class="value">{formatTokens(contextInfo.skills.total)} tokens</span>
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
              <div class="session-row">
                <span class="session-name">{session.name}</span>
                <span class="session-tokens">
                  {#if session.contextTokens > 0}
                    {formatTokens(session.contextTokens)}{#if session.contextWindow} / {formatTokens(session.contextWindow)}{/if} tokens
                  {:else}
                    <span class="no-data">no data yet</span>
                  {/if}
                </span>
              </div>
              {#if session.contextTokens > 0}
                <div class="token-bar">
                  <div class="token-bar-fill" style:width="{Math.min(100, (session.contextTokens / contextWindow) * 100)}%"></div>
                </div>
                {#if session.breakdown}
                  <div class="session-breakdown">
                    <div class="breakdown-row sub">
                      <span class="label">System Prompt</span>
                      <span class="value">{formatTokens(session.breakdown.systemPrompt)} tokens</span>
                    </div>
                    <div class="breakdown-row sub">
                      <span class="label">Skills</span>
                      <span class="value">{formatTokens(session.breakdown.skills)} tokens</span>
                    </div>
                    <div class="breakdown-row sub">
                      <span class="label">User Messages</span>
                      <span class="value">{formatTokens(session.breakdown.conversation.userText)} tokens</span>
                    </div>
                    <div class="breakdown-row sub">
                      <span class="label">Assistant Text</span>
                      <span class="value">{formatTokens(session.breakdown.conversation.assistantText)} tokens</span>
                    </div>
                    {#if session.breakdown.conversation.thinking > 0}
                      <div class="breakdown-row sub">
                        <span class="label">Thinking</span>
                        <span class="value">{formatTokens(session.breakdown.conversation.thinking)} tokens</span>
                      </div>
                    {/if}
                    {#if session.breakdown.conversation.toolUse > 0}
                      <div class="breakdown-row sub">
                        <span class="label">Tool Calls</span>
                        <span class="value">{formatTokens(session.breakdown.conversation.toolUse)} tokens</span>
                      </div>
                    {/if}
                    {#if session.breakdown.conversation.toolResult > 0}
                      <div class="breakdown-row sub">
                        <span class="label">Tool Results</span>
                        <span class="value">{formatTokens(session.breakdown.conversation.toolResult)} tokens</span>
                      </div>
                    {/if}
                  </div>
                {/if}
              {/if}
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

  .breakdown-row.sub {
    font-size: 12px;
    padding: 2px 8px;
  }

  .breakdown-row.sub .label {
    color: var(--text-2);
  }

  .breakdown-row.sub .value {
    color: var(--text-3);
  }

  .label {
    color: var(--text-1);
  }

  .value {
    color: var(--text-2);
    font-variant-numeric: tabular-nums;
  }

  .sessions {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .session-row {
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

  .session-breakdown {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding-left: 8px;
    margin-top: 4px;
    border-left: 2px solid var(--border);
  }
</style>
