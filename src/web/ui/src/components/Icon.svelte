<script lang="ts">
let {
  kind,
  class: className = "",
}: {
  kind:
    | "mind"
    | "brain"
    | "spiral"
    | "history"
    | "heartbeat"
    | "dream"
    | "sleep"
    | "clock"
    | "chat"
    | "text"
    | "thinking"
    | "terminal"
    | "file"
    | "search"
    | "globe"
    | "generic-tool"
    | "document-lines"
    | "gear"
    | "folder";
  class?: string;
} = $props();
</script>

{#if kind === "mind"}
  <svg class={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="8" width="16" height="12" rx="2"/><circle cx="9" cy="14" r="1.5"/><circle cx="15" cy="14" r="1.5"/><line x1="12" y1="4" x2="12" y2="8"/><circle cx="12" cy="3" r="1"/></svg>
{:else if kind === "brain"}
  <svg class={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><circle cx="9" cy="11" r="1.5"/><circle cx="15" cy="11" r="1.5"/><line x1="10" y1="16" x2="14" y2="16"/></svg>
{:else if kind === "spiral"}
  <svg class={className} viewBox="-1.2 -1.6 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M8 7.2a.8.8 0 0 1 .8.8 1.6 1.6 0 0 1-1.6 1.6A2.4 2.4 0 0 1 4.8 7.2a3.2 3.2 0 0 1 3.2-3.2 4 4 0 0 1 4 4 4.8 4.8 0 0 1-4.8 4.8A5.6 5.6 0 0 1 1.6 7.2 6.4 6.4 0 0 1 8 .8"/></svg>
{:else if kind === "history"}
  <svg class={className} viewBox="0 0 16 16"><line x1="4" y1="2" x2="4" y2="14" stroke="currentColor" stroke-width="1.5"/><path d="M4 2H12V8" stroke="currentColor" stroke-width="1.5" fill="none"/><circle cx="4" cy="2" r="2" fill="currentColor"/><circle cx="4" cy="14" r="2" fill="currentColor"/><circle cx="12" cy="8" r="2" fill="currentColor"/></svg>
{:else if kind === "heartbeat"}
  <svg class={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 8 4 8 6 3 8 13 10 6 12 8 15 8"/></svg>
{:else if kind === "dream"}
  <svg class={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M7 3a4 4 0 0 0-4 4c0 2.2 1.8 4 4 4h3a3 3 0 1 0-.5-5.96A4 4 0 0 0 7 3z"/><circle cx="13" cy="3" r="0.5" fill="currentColor"/><circle cx="11" cy="1.5" r="0.5" fill="currentColor"/></svg>
{:else if kind === "sleep"}
  <svg class={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13 9A6 6 0 1 1 7 3a5 5 0 0 0 6 6z"/></svg>
{:else if kind === "clock"}
  <svg class={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6"/><path d="M8 4v4l3 2"/></svg>
{:else if kind === "chat"}
  <svg class={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h12v8H5l-3 3V3z"/></svg>
{:else if kind === "text"}
  <svg class={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4h10M3 8h7M3 12h9"/></svg>
{:else if kind === "thinking"}
  <svg class={className} viewBox="-1 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12C1.5 12 0 10.5 0 8.5 0 7 1 5.5 2.5 5 2.5 3 4 1.5 6 1.5c1.5 0 2.8.8 3.3 2 .4-.2.8-.3 1.2-.3 1.7 0 3 1.3 3 3 1.2.4 2.5 1.4 2.5 3 0 1.7-1.3 3.8-3.5 3.8H4z"/></svg>
{:else if kind === "terminal"}
  <svg class={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5l4 3-4 3"/><path d="M9 12h4"/></svg>
{:else if kind === "file"}
  <svg class={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 2h6l4 4v8H4V2z"/><path d="M10 2v4h4"/></svg>
{:else if kind === "search"}
  <svg class={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="7" cy="7" r="4"/><path d="M10 10l3 3"/></svg>
{:else if kind === "globe"}
  <svg class={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6"/><path d="M2 8h12"/><path d="M8 2c2 2 3 4 3 6s-1 4-3 6"/><path d="M8 2c-2 2-3 4-3 6s1 4 3 6"/></svg>
{:else if kind === "generic-tool"}
  <svg class={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="10" height="10" rx="1"/><path d="M6 6h4M6 8h4M6 10h2"/></svg>
{:else if kind === "document-lines"}
  <svg class={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 2h6l4 4v8H4V2z"/><path d="M10 2v4h4"/><path d="M6 9h6M6 12h4"/></svg>
{:else if kind === "gear"}
  <svg class={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M14 3.27A1.27 1.27 0 0 0 12.73 2h-1.46A1.27 1.27 0 0 0 10 3.27c0 .58-.4 1.07-.93 1.29a8 8 0 0 0-.26.1c-.53.23-1.16.16-1.57-.25a1.27 1.27 0 0 0-1.8 0l-1.03 1.03a1.27 1.27 0 0 0 0 1.8c.41.41.48 1.04.25 1.57a8 8 0 0 0-.1.25c-.22.54-.71.94-1.29.94A1.27 1.27 0 0 0 2 11.27v1.46A1.27 1.27 0 0 0 3.27 14c.58 0 1.07.4 1.29.93.03.09.07.17.1.26.23.53.16 1.16-.25 1.57a1.27 1.27 0 0 0 0 1.8l1.03 1.03a1.27 1.27 0 0 0 1.8 0c.41-.41 1.04-.48 1.57-.25.09.04.17.07.26.1.54.22.93.71.93 1.29A1.27 1.27 0 0 0 11.27 22h1.46A1.27 1.27 0 0 0 14 20.73c0-.58.4-1.07.93-1.29.09-.03.17-.07.26-.1.53-.23 1.16-.16 1.57.25a1.27 1.27 0 0 0 1.8 0l1.03-1.03a1.27 1.27 0 0 0 0-1.8c-.41-.41-.48-1.04-.25-1.57.04-.09.07-.17.1-.26.22-.54.71-.93 1.29-.93A1.27 1.27 0 0 0 22 12.73v-1.46A1.27 1.27 0 0 0 20.73 10c-.58 0-1.07-.4-1.29-.93a8 8 0 0 0-.1-.26c-.23-.53-.16-1.16.25-1.57a1.27 1.27 0 0 0 0-1.8l-1.03-1.03a1.27 1.27 0 0 0-1.8 0c-.41.41-1.04.48-1.57.25a8 8 0 0 0-.26-.1C14.4 4.34 14 3.85 14 3.27z"/></svg>
{:else if kind === "folder"}
  <svg class={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4h5l2-2h5v11H2V4z"/></svg>
{/if}
