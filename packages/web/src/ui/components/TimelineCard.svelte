<script lang="ts">
import { Icon } from "@volute/ui";
import { renderMarkdown } from "@volute/ui/markdown";
import { sanitizeSvg } from "@volute/ui/sanitize";
import type { ComponentProps, Snippet } from "svelte";
import type { CardBody } from "../lib/timeline-card";

let {
  title,
  color = "text-2",
  icon,
  iconKind,
  meta,
  metaHandle,
  time,
  body = { kind: "none" },
  onclick,
  oncollapse,
  children,
}: {
  title: string;
  /** Palette color name (e.g. "blue", "purple", extension color). */
  color?: string;
  /** Raw SVG markup for the header icon (sanitized here). */
  icon?: string;
  /** Built-in icon, used when no raw SVG is given. */
  iconKind?: ComponentProps<typeof Icon>["kind"];
  /** Secondary header text: sender, author, "system event". */
  meta?: string;
  /**
   * The raw sender handle, shown muted beside `meta` when `meta` is a display name.
   * Both are shown: the display name is what the person calls themselves, the handle
   * is where they came from (#1024).
   */
  metaHandle?: string;
  /** Pre-formatted time string (caller picks relative vs absolute). */
  time?: string;
  body?: CardBody;
  /** When set, the card is interactive and clicking it navigates. */
  onclick?: () => void;
  /** When set, a ✕ button in the header collapses the card. */
  oncollapse?: () => void;
  /** Optional body override (replaces `body` rendering). */
  children?: Snippet;
} = $props();

let cardColor = $derived(`var(--${color})`);
let iframeLoaded = $state(false);

function handleClick(e: Event) {
  e.stopPropagation();
  onclick?.();
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    handleClick(e);
  }
}
</script>

<!--
  Interactive only when there is somewhere to navigate; otherwise inert so
  clicks bubble to the parent (in the timeline: HistoryEvent's collapse toggle).
  div[role=button] rather than <button> — the card can sit inside another
  role=button element and may contain the real ✕ button.
-->
<!-- svelte-ignore a11y_no_noninteractive_tabindex (role/tabindex are set together, only when onclick exists) -->
<div
  class="timeline-card"
  class:clickable={!!onclick}
  role={onclick ? "button" : undefined}
  tabindex={onclick ? 0 : undefined}
  onclick={onclick ? handleClick : undefined}
  onkeydown={onclick ? handleKeydown : undefined}
  style:border-color="color-mix(in srgb, {cardColor} 25%, var(--border))"
>
  <div class="card-header" style:border-bottom-color="color-mix(in srgb, {cardColor} 25%, var(--border))">
    {#if icon}
      <span class="card-icon" style:color={cardColor}>{@html sanitizeSvg(icon)}</span>
    {:else if iconKind}
      <span class="card-icon" style:color={cardColor}><Icon kind={iconKind} /></span>
    {/if}
    <span class="card-title">{title}</span>
    {#if meta}
      <span class="card-meta" title={meta}>{meta}</span>
    {/if}
    {#if metaHandle}
      <span class="card-handle" title={metaHandle}>({metaHandle})</span>
    {/if}
    {#if time}
      <span class="card-time">{time}</span>
    {/if}
    {#if oncollapse}
      <button
        class="card-close"
        aria-label="Collapse"
        onclick={(e) => { e.stopPropagation(); oncollapse(); }}
      >&#x2715;</button>
    {/if}
  </div>
  {#if children}
    <div class="card-body">{@render children()}</div>
  {:else if body.kind === "iframe"}
    <div class="card-body card-body-iframe">
      <iframe
        src={body.url}
        class="page-preview"
        class:loaded={iframeLoaded}
        title={title}
        sandbox="allow-same-origin"
        role="presentation"
        onpointerdown={(e) => e.preventDefault()}
        onload={() => (iframeLoaded = true)}
      ></iframe>
    </div>
  {:else if body.kind === "markdown"}
    <div class="card-body card-body-scroll">
      <div class="body-html markdown-body">{@html renderMarkdown(body.source)}</div>
    </div>
  {:else if body.kind === "text"}
    <div class="card-body card-body-scroll">
      <div class="body-text">{body.text}</div>
    </div>
  {/if}
</div>

<style>
  .timeline-card {
    background: var(--bg-0);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    display: flex;
    flex-direction: column;
    max-height: var(--card-max-height, 240px);
    overflow: hidden;
    transition: border-color 0.15s;
    width: 100%;
    text-align: left;
  }

  .timeline-card.clickable {
    cursor: pointer;
  }

  .timeline-card.clickable:hover {
    border-color: var(--border-bright);
  }

  .card-header {
    padding: 6px 8px 6px 10px;
    font-size: 13px;
    font-weight: 500;
    color: var(--text-1);
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .card-icon {
    display: flex;
    flex-shrink: 0;
  }

  .card-icon :global(svg) {
    width: 14px;
    height: 14px;
  }

  .card-title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
    flex: 1;
  }

  /*
   * A sender renders as two spans — display name then handle (#1024) — and both may be
   * long. They shrink together (rather than the handle alone being crushed to "(") so a
   * cramped header still shows a legible piece of each; `title` carries the full handle.
   */
  .card-meta {
    font-size: 11px;
    color: var(--accent);
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .card-time {
    font-size: 11px;
    color: var(--text-2);
    font-weight: 400;
    flex-shrink: 0;
    margin-left: auto;
  }

  .card-handle {
    font-size: 11px;
    color: var(--text-2);
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .card-meta + .card-time,
  .card-handle + .card-time {
    margin-left: 0;
  }

  .card-close {
    background: none;
    border: none;
    padding: 0 2px;
    cursor: pointer;
    color: var(--text-2);
    font-size: 11px;
    line-height: 1;
    flex-shrink: 0;
  }

  .card-close:hover {
    color: var(--text-0);
  }

  .card-body {
    flex: 1;
    overflow: hidden;
    min-height: 0;
  }

  .card-body-scroll {
    overflow-y: auto;
  }

  .body-html {
    padding: 8px 12px;
    font-size: 13px;
    color: var(--text-0);
    line-height: 1.5;
  }

  .body-text {
    padding: 8px 12px;
    font-family: var(--mono);
    font-size: 13px;
    color: var(--text-0);
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .page-preview {
    width: 100%;
    height: 100%;
    border: none;
    pointer-events: none;
    background: white;
    opacity: 0;
    transition: opacity 0.15s;
  }

  .page-preview.loaded {
    opacity: 1;
  }
</style>
