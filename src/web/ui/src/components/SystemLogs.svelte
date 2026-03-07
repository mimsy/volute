<script lang="ts">
import { SvelteSet } from "svelte/reactivity";
import { createSystemLogStream } from "../lib/streams";

type LogEntry = {
  level: string;
  msg: string;
  ts: string;
  cat?: string;
  data?: Record<string, unknown>;
};

const LEVEL_COLORS: Record<string, string> = {
  info: "var(--text-2)",
  warn: "var(--yellow)",
  error: "var(--red)",
  debug: "var(--text-2)",
};

let entries = $state<LogEntry[]>([]);
let autoScroll = $state(true);
let error = $state("");
let scrollEl: HTMLDivElement;

let disabledLevels = new SvelteSet<string>();
let disabledCategories = new SvelteSet<string>();
let hasDebug = $derived(entries.some((e) => e.level === "debug"));
let allCategories = $derived(
  [...new Set(entries.map((e) => e.cat).filter((c): c is string => !!c))].sort(),
);
let filtersActive = $derived(disabledLevels.size > 0 || disabledCategories.size > 0);
let filteredEntries = $derived(
  filtersActive
    ? entries.filter(
        (e) => !disabledLevels.has(e.level) && (!e.cat || !disabledCategories.has(e.cat)),
      )
    : entries,
);

function toggle(set: SvelteSet<string>, value: string) {
  if (set.has(value)) set.delete(value);
  else set.add(value);
}

function clearFilters() {
  disabledLevels.clear();
  disabledCategories.clear();
}

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
    void filteredEntries.length;
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
    <span class="count">
      {#if filtersActive}
        {filteredEntries.length} / {entries.length} entries
      {:else}
        {entries.length} entries
      {/if}
    </span>
  </div>
  <div class="filter-bar">
    <div class="filter-group">
      <button
        class="pill pill-info"
        class:inactive={disabledLevels.has("info")}
        onclick={() => toggle(disabledLevels, "info")}
      >info</button>
      <button
        class="pill pill-warn"
        class:inactive={disabledLevels.has("warn")}
        onclick={() => toggle(disabledLevels, "warn")}
      >warn</button>
      <button
        class="pill pill-error"
        class:inactive={disabledLevels.has("error")}
        onclick={() => toggle(disabledLevels, "error")}
      >error</button>
      {#if hasDebug}
        <button
          class="pill pill-debug"
          class:inactive={disabledLevels.has("debug")}
          onclick={() => toggle(disabledLevels, "debug")}
        >debug</button>
      {/if}
    </div>
    {#if allCategories.length > 0}
      <div class="filter-sep"></div>
      <div class="filter-group">
        {#each allCategories as cat (cat)}
          <button
            class="pill pill-cat"
            class:inactive={disabledCategories.has(cat)}
            onclick={() => toggle(disabledCategories, cat)}
          >{cat}</button>
        {/each}
      </div>
    {/if}
    {#if filtersActive}
      <button class="pill pill-clear" onclick={clearFilters}>clear</button>
    {/if}
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
    {#each filteredEntries as entry, i (i)}
      <div class="log-line">
        <span class="ts">{formatTime(entry.ts)}</span>
        <span class="level" style:color={LEVEL_COLORS[entry.level] || "var(--text-2)"}>{entry.level}</span>
        {#if entry.cat}<span class="cat">{entry.cat}</span>{/if}
        <span class="msg">{entry.msg}{#if entry.data} <span class="data">{formatData(entry.data)}</span>{/if}</span>
      </div>
    {/each}
  </div>
</div>

<style>
  .system-logs {
    display: flex;
    flex-direction: column;
    height: 100%;
  }

  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 8px;
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

  .filter-bar {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 8px;
    flex-shrink: 0;
    flex-wrap: wrap;
  }

  .filter-group {
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
  }

  .filter-sep {
    width: 1px;
    height: 16px;
    background: var(--border);
    margin: 0 4px;
  }

  .pill {
    padding: 2px 8px;
    border-radius: 10px;
    font-size: 10px;
    font-family: var(--mono);
    cursor: pointer;
    border: 1px solid transparent;
    transition: opacity 0.1s;
  }

  .pill-info,
  .pill-debug {
    background: color-mix(in srgb, var(--text-2) 15%, transparent);
    color: var(--text-2);
  }

  .pill-warn {
    background: color-mix(in srgb, var(--yellow) 15%, transparent);
    color: var(--yellow);
  }

  .pill-error {
    background: color-mix(in srgb, var(--red) 15%, transparent);
    color: var(--red);
  }

  .pill-cat {
    background: var(--bg-3);
    color: var(--text-2);
  }

  .pill-clear {
    background: none;
    color: var(--text-2);
    border: 1px dashed var(--border);
    margin-left: 4px;
  }

  .pill-clear:hover {
    color: var(--text-1);
    border-color: var(--text-2);
  }

  .pill.inactive {
    opacity: 0.3;
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
    display: flex;
    gap: 1ch;
  }

  .ts {
    color: var(--text-2);
    flex-shrink: 0;
  }

  .level {
    flex-shrink: 0;
    width: 5ch;
  }

  .cat {
    color: var(--text-2);
    opacity: 0.6;
    flex-shrink: 0;
    width: 12ch;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .msg {
    color: var(--text-0);
    white-space: pre-wrap;
    word-break: break-word;
    min-width: 0;
  }

  .data {
    color: var(--text-2);
    white-space: pre-wrap;
    word-break: break-word;
  }
</style>
