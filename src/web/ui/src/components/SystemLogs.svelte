<script lang="ts">
import { createSystemLogStream } from "../lib/streams";

type LogEntry = {
  level: string;
  msg: string;
  ts: string;
  data?: Record<string, unknown>;
};

const LEVEL_COLORS: Record<string, string> = {
  info: "var(--text-2)",
  warn: "var(--yellow)",
  error: "var(--red)",
};

let entries = $state<LogEntry[]>([]);
let autoScroll = $state(true);
let error = $state("");
let scrollEl: HTMLDivElement;

function onLine(line: string) {
  try {
    const entry = JSON.parse(line) as LogEntry;
    entries.push(entry);
    if (entries.length > 2000) {
      entries = entries.slice(-2000);
    }
  } catch {
    // skip invalid JSON lines
  }
}

$effect(() => {
  error = "";
  const { start, stop } = createSystemLogStream(onLine, (msg) => {
    error = msg;
  });
  start();
  return stop;
});

$effect(() => {
  if (autoScroll && scrollEl) {
    void entries.length;
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

function formatTime(ts: string): string {
  try {
    return new Date(ts).toLocaleTimeString();
  } catch {
    return ts;
  }
}

function formatData(data: Record<string, unknown>): string {
  return Object.entries(data)
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(" ");
}
</script>

<div class="system-logs">
  <div class="header">
    <span class="title">System Logs</span>
    <span class="count">{entries.length} entries</span>
  </div>
  {#if !autoScroll}
    <div class="pause-bar">
      <span>Scroll paused</span>
      <button class="resume-btn" onclick={resumeScroll}>Resume</button>
    </div>
  {/if}
  <div class="log-output" bind:this={scrollEl} onscroll={handleScroll}>
    {#if error}
      <span class="error">{error}</span>
    {:else if entries.length === 0}
      <span class="waiting">Waiting for logs...</span>
    {/if}
    {#each entries as entry, i (i)}
      <div class="log-line">
        <span class="ts">{formatTime(entry.ts)}</span>
        {" "}
        <span class="level" style:color={LEVEL_COLORS[entry.level] || "var(--text-2)"}>
          {entry.level.padEnd(5)}
        </span>
        {" "}
        <span class="msg">{entry.msg}</span>
        {#if entry.data}
          <span class="data"> {formatData(entry.data)}</span>
        {/if}
      </div>
    {/each}
  </div>
</div>

<style>
  .system-logs {
    display: flex;
    flex-direction: column;
    height: calc(100vh - 48px - 48px);
  }

  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 12px;
    flex-shrink: 0;
  }

  .title {
    color: var(--text-1);
    font-size: 13px;
    font-weight: 500;
  }

  .count {
    color: var(--text-2);
    font-size: 11px;
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
    flex-shrink: 0;
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
    color: var(--text-1);
    background: var(--bg-0);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
  }

  .waiting {
    color: var(--text-2);
  }

  .error {
    color: var(--red);
  }

  .log-line {
    animation: fadeIn 0.1s ease both;
    white-space: pre-wrap;
  }

  .ts {
    color: var(--text-2);
  }

  .msg {
    color: var(--text-0);
  }

  .data {
    color: var(--text-2);
  }
</style>
