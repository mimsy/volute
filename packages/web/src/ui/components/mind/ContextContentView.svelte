<script lang="ts">
import { renderMarkdown } from "@volute/ui";
import type { ContextMessages } from "../../lib/client";

let { messages }: { messages: ContextMessages } = $props();
</script>

<div class="context-view">
  <!-- Preamble sections -->
  <div class="preamble">
    {#if messages.preamble.systemPrompt}
      <details class="section">
        <summary class="section-header">System Prompt</summary>
        <div class="section-body markdown-body">
          {@html renderMarkdown(messages.preamble.systemPrompt)}
        </div>
      </details>
    {/if}

    {#if messages.preamble.sdkInstructions}
      <details class="section">
        <summary class="section-header">SDK Instructions</summary>
        <div class="section-body markdown-body">
          {@html renderMarkdown(messages.preamble.sdkInstructions)}
        </div>
      </details>
    {/if}

    {#if messages.preamble.skillDescriptions.length > 0}
      <details class="section">
        <summary class="section-header">Skill Descriptions ({messages.preamble.skillDescriptions.length})</summary>
        <div class="section-body">
          {#each messages.preamble.skillDescriptions as skill}
            <div class="skill-item">
              <span class="skill-name">{skill.name}</span>
              <span class="skill-desc">{skill.description}</span>
            </div>
          {/each}
        </div>
      </details>
    {/if}
  </div>

  <!-- Session messages -->
  {#each messages.sessions as session (session.name)}
    <div class="session">
      <div class="session-label">{session.name}</div>

      {#if session.messages.length === 0}
        <div class="empty">No messages yet</div>
      {:else}
        <div class="messages">
          {#each session.messages as msg, i (i)}
            <div class="message" class:user={msg.role === "user"} class:assistant={msg.role === "assistant"} class:system={msg.role === "system"}>
              <div class="role-label" class:user-label={msg.role === "user"} class:assistant-label={msg.role === "assistant"} class:system-label={msg.role === "system"}>
                {msg.role}
              </div>
              <div class="blocks">
                {#each msg.blocks as block}
                  {#if block.type === "text"}
                    {#if msg.role === "system"}
                      <pre class="block-system-text">{block.text}</pre>
                    {:else}
                      <div class="block-text markdown-body">
                        {@html renderMarkdown(block.text)}
                      </div>
                    {/if}
                  {:else if block.type === "thinking"}
                    <details class="block-thinking">
                      <summary class="thinking-header">Thinking</summary>
                      <div class="thinking-body">{block.text}</div>
                    </details>
                  {:else if block.type === "tool_use"}
                    <details class="block-tool">
                      <summary class="tool-header">{block.name}</summary>
                      <pre class="tool-body">{block.input}</pre>
                    </details>
                  {:else if block.type === "tool_result"}
                    <details class="block-tool">
                      <summary class="tool-header" class:tool-error={block.isError}>Result{#if block.isError} (error){/if}</summary>
                      <pre class="tool-body">{block.text}</pre>
                    </details>
                  {/if}
                {/each}
              </div>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  {/each}
</div>

<style>
  .context-view {
    padding: 16px;
    overflow-y: auto;
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  /* Preamble sections */

  .preamble {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .section {
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }

  .section-header {
    padding: 8px 12px;
    font-size: 12px;
    font-weight: 600;
    color: var(--text-1);
    cursor: pointer;
    user-select: none;
  }

  .section-header:hover {
    color: var(--text-0);
  }

  .section-body {
    padding: 12px;
    border-top: 1px solid var(--border);
    font-size: 13px;
    color: var(--text-1);
    max-height: 400px;
    overflow-y: auto;
  }

  .skill-item {
    display: flex;
    gap: 8px;
    padding: 4px 0;
    font-size: 12px;
  }

  .skill-name {
    font-weight: 600;
    color: var(--text-1);
    white-space: nowrap;
  }

  .skill-desc {
    color: var(--text-2);
  }

  /* Sessions */

  .session {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .session-label {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-2);
    padding: 0 4px;
  }

  .empty {
    font-size: 12px;
    color: var(--text-3);
    font-style: italic;
    padding: 8px 4px;
  }

  /* Messages */

  .messages {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .message {
    display: flex;
    gap: 8px;
    padding: 6px 8px;
    border-radius: var(--radius);
  }

  .message.user {
    background: var(--bg-2);
  }

  .message.assistant {
    background: transparent;
  }

  .message.system {
    background: var(--bg-2);
    border-left: 2px solid var(--text-3);
  }

  .role-label {
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    padding-top: 3px;
    flex-shrink: 0;
    width: 56px;
  }

  .user-label {
    color: var(--accent, #3b82f6);
  }

  .assistant-label {
    color: var(--green, #22c55e);
  }

  .system-label {
    color: var(--text-3);
  }

  .blocks {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .block-text {
    font-size: 13px;
    color: var(--text-1);
    line-height: 1.5;
  }

  .block-system-text {
    font-size: 12px;
    color: var(--text-2);
    white-space: pre-wrap;
    font-family: var(--mono);
    margin: 0;
    line-height: 1.5;
  }

  /* Thinking blocks */

  .block-thinking {
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }

  .thinking-header {
    padding: 4px 8px;
    font-size: 11px;
    font-weight: 500;
    color: var(--text-3);
    cursor: pointer;
    font-style: italic;
  }

  .thinking-body {
    padding: 8px;
    border-top: 1px solid var(--border);
    font-size: 12px;
    color: var(--text-2);
    white-space: pre-wrap;
    font-family: var(--mono);
    max-height: 300px;
    overflow-y: auto;
  }

  /* Tool blocks */

  .block-tool {
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }

  .tool-header {
    padding: 4px 8px;
    font-size: 11px;
    font-weight: 600;
    color: var(--text-2);
    cursor: pointer;
    font-family: var(--mono);
  }

  .tool-error {
    color: var(--danger, #e53e3e);
  }

  .tool-body {
    padding: 8px;
    border-top: 1px solid var(--border);
    font-size: 11px;
    color: var(--text-2);
    white-space: pre-wrap;
    word-break: break-all;
    font-family: var(--mono);
    max-height: 200px;
    overflow-y: auto;
    margin: 0;
    background: var(--bg-2);
  }

  /* Markdown */

  :global(.context-view .markdown-body) {
    font-size: 13px;
    line-height: 1.5;
  }

  :global(.context-view .markdown-body pre) {
    background: var(--bg-2);
    padding: 8px;
    border-radius: var(--radius);
    overflow-x: auto;
    font-size: 12px;
  }

  :global(.context-view .markdown-body code) {
    font-family: var(--mono);
    font-size: 12px;
  }

  :global(.context-view .markdown-body p) {
    margin: 0 0 8px;
  }

  :global(.context-view .markdown-body p:last-child) {
    margin-bottom: 0;
  }
</style>
