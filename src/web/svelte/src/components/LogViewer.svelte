<script lang="ts">
import { createLogStream } from "../lib/streams";

let { name }: { name: string } = $props();

let lines = $state<string[]>([]);
let autoScroll = $state(true);
let scrollEl: HTMLDivElement;

function onLine(line: string) {
  lines.push(line);
  if (lines.length > 2000) {
    lines = lines.slice(-2000);
  }
}

$effect(() => {
  const { start, stop } = createLogStream(name, onLine);
  start();
  return stop;
});

$effect(() => {
  if (autoScroll && scrollEl) {
    void lines.length;
    scrollEl.scrollTop = scrollEl.scrollHeight;
  }
});

function handleScroll() {
  if (!scrollEl) return;
  const atBottom = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < 30;
  autoScroll = atBottom;
}

function resumeScroll() {
  autoScroll = true;
  if (scrollEl) {
    scrollEl.scrollTop = scrollEl.scrollHeight;
  }
}
</script>

<div class="log-viewer">
  {#if !autoScroll}
    <div class="pause-bar">
      <span>Scroll paused</span>
      <button class="resume-btn" onclick={resumeScroll}>Resume</button>
    </div>
  {/if}
  <div class="log-output" bind:this={scrollEl} onscroll={handleScroll}>
    {#if lines.length === 0}
      <span class="waiting">Waiting for logs...</span>
    {/if}
    {#each lines as line, i (i)}
      <div class="log-line">{line}</div>
    {/each}
  </div>
</div>

<style>
  .log-viewer {
    display: flex;
    flex-direction: column;
    height: 100%;
  }

  .pause-bar {
    padding: 6px 12px;
    background: var(--bg-3);
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 11px;
    color: var(--text-2);
  }

  .resume-btn {
    background: var(--accent-dim);
    color: var(--accent);
    padding: 2px 10px;
    border-radius: var(--radius);
    font-size: 11px;
  }

  .log-output {
    flex: 1;
    overflow: auto;
    padding: 12px;
    font-family: var(--mono);
    font-size: 11px;
    line-height: 1.7;
    white-space: pre-wrap;
    word-break: break-all;
    color: var(--text-1);
    background: var(--bg-0);
  }

  .waiting {
    color: var(--text-2);
  }

  .log-line {
    animation: fadeIn 0.1s ease both;
  }
</style>
