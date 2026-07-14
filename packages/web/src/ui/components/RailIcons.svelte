<script lang="ts">
import type { SummaryIcons, TurnConversation, TurnRow } from "@volute/api";
import { Icon } from "@volute/ui";
import { renderMarkdown } from "@volute/ui/markdown";
import { sanitizeSvg } from "@volute/ui/sanitize";
import { SvelteSet } from "svelte/reactivity";
import { extractTextContent } from "../lib/feed-utils";
import { formatRelativeTime } from "../lib/format";
import { navigate } from "../lib/navigate";
import {
  activityColor,
  activityNavUrl,
  activityPeekBody,
  activityTypeLabel,
  isUuid,
} from "../lib/peek";
import { turnRailParts } from "../lib/turn-rail";
import TimelineCard from "./TimelineCard.svelte";

/**
 * Rail decorations for one timeline row, positioned against the nearest
 * positioned ancestor (the rail or the row). Two modes:
 *
 * - `turn`: the trigger renders as a hoverable chip at the marker position
 *   (chat for a message, gear for a system event) and everything else that
 *   happened in the turn stacks below, one chip per item.
 * - `groups`: grouped period icons (one chat chip for all conversations, one
 *   gear for all events, one chip per activity type) with count badges.
 *
 * Parents place the chips via CSS custom properties: `--rail-x` (horizontal
 * center, default 50%), `--trigger-top` (default 7px, centering an 18px chip
 * on a dot at y=16), and `--stack-top`.
 */
let {
  turn,
  groups,
  mind,
  condensed = false,
  showStack = true,
  onopenconversation,
}: {
  turn?: TurnRow;
  groups?: SummaryIcons;
  mind: string;
  condensed?: boolean;
  showStack?: boolean;
  onopenconversation?: (conv: Pick<TurnConversation, "id" | "label" | "type">) => void;
} = $props();

let parts = $derived(turn ? turnRailParts(turn) : undefined);

// Peek popovers render markdown / mount live iframes, so their content is
// mounted lazily on first hover and then kept (frozen) — see #541.
const revealed = new SvelteSet<string>();
function reveal(key: string) {
  revealed.add(key);
}
</script>

{#snippet chatPeekCard(conv: TurnConversation)}
  <TimelineCard title={conv.label} color="blue" iconKind="chat" meta={`${conv.messages.length} msg${conv.messages.length === 1 ? '' : 's'}`}>
    <div class="peek-msgs">
      {#each conv.messages.slice(-5) as msg (msg.id)}
        <div class="peek-msg">
          <span class="peek-msg-sender" class:peek-msg-sender-user={msg.role === "user"}>{msg.sender_name ?? (msg.role === "user" ? "user" : mind)}</span>
          {#if msg.role === "assistant"}
            <span class="peek-msg-md markdown-body">{@html renderMarkdown(extractTextContent(msg.content))}</span>
          {:else}
            <span>{extractTextContent(msg.content)}</span>
          {/if}
        </div>
      {/each}
    </div>
  </TimelineCard>
{/snippet}

{#if turn && parts}
  {#if turn.trigger}
    {@const trigger = turn.trigger}
    {@const triggerEvt = parts.triggerEvt}
    {@const triggerConv = parts.triggerConv}
    <!-- Hoverable trigger chip at the marker position. Clicks fall through to
         the parent row's expand toggle. -->
    <div class="peek-anchor rail-trigger">
      <button class="peek-btn" style:color={trigger.event ? "var(--purple)" : "var(--blue)"} aria-label="View trigger" onmouseenter={() => reveal("trigger")} onfocus={() => reveal("trigger")}>
        <Icon kind={trigger.event ? "gear" : "chat"} />
      </button>
      {#if trigger.event}
        <div class="peek-popover">
          {#if revealed.has("trigger")}
            <TimelineCard title={trigger.event.label} color="purple" iconKind="gear" meta="system event" body={{ kind: "text", text: triggerEvt?.content ?? trigger.content ?? "" }} />
          {/if}
        </div>
      {:else if triggerConv}
        {@const conv = triggerConv}
        <div class="peek-popover" role="button" tabindex="0"
          onclick={(e) => { e.stopPropagation(); onopenconversation?.(conv); }}
          onkeydown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); onopenconversation?.(conv); } }}
        >
          {#if revealed.has("trigger")}
            {@render chatPeekCard(conv)}
          {/if}
        </div>
      {:else}
        <div class="peek-popover">
          {#if revealed.has("trigger")}
            <TimelineCard title={trigger.channel || "message"} color="blue" iconKind="chat" meta={trigger.sender ?? undefined} body={{ kind: "text", text: trigger.content ?? "" }} />
          {/if}
        </div>
      {/if}
    </div>
  {/if}
  {#if showStack && parts.stackCount > 0}
    <div class="rail-stack" class:condensed>
      {#each parts.stackConvs as conv (conv.id)}
        {@const chatKey = `conv:${conv.id}`}
        <div class="peek-anchor">
          <button class="peek-btn" aria-label="View conversation" onmouseenter={() => reveal(chatKey)} onfocus={() => reveal(chatKey)} onclick={(e) => e.stopPropagation()}>
            <Icon kind="chat" />
          </button>
          <div class="peek-popover" role="button" tabindex="0"
            onclick={(e) => { e.stopPropagation(); onopenconversation?.(conv); }}
            onkeydown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); onopenconversation?.(conv); } }}
          >
            {#if revealed.has(chatKey)}
              {@render chatPeekCard(conv)}
            {/if}
          </div>
        </div>
      {/each}
      <!--
        System events peek with a gear, not the chat icon, and their card has no
        sender and no click-to-open-conversation: there is no conversation to open.
      -->
      {#each parts.stackEvents as evt (evt.id)}
        {@const evtKey = `event:${evt.id}`}
        <div class="peek-anchor">
          <button class="peek-btn" style:color="var(--purple)" aria-label="View system event" onmouseenter={() => reveal(evtKey)} onfocus={() => reveal(evtKey)} onclick={(e) => e.stopPropagation()}>
            <Icon kind="gear" />
          </button>
          <div class="peek-popover">
            {#if revealed.has(evtKey)}
              <TimelineCard title={evt.label} color="purple" iconKind="gear" meta="system event" body={{ kind: "text", text: evt.content ?? "" }} />
            {/if}
          </div>
        </div>
      {/each}
      {#each turn.activities as act (act.id)}
        {@const actKey = `act:${act.id}`}
        {@const actColor = activityColor(act.metadata)}
        {@const actIcon = typeof act.metadata?.icon === 'string' ? sanitizeSvg(act.metadata.icon) : ''}
        {@const actUrl = activityNavUrl(act.metadata, mind)}
        <div class="peek-anchor">
          <button class="peek-btn" style:color="var(--{actColor})" aria-label="View activity" onmouseenter={() => reveal(actKey)} onfocus={() => reveal(actKey)} onclick={(e) => { e.stopPropagation(); if (actUrl) navigate(actUrl); }}>
            {#if actIcon}
              {@html actIcon}
            {:else}
              <Icon kind="document-lines" />
            {/if}
          </button>
          <div class="peek-popover">
            {#if revealed.has(actKey)}
              <TimelineCard
                title={act.summary}
                color={actColor}
                icon={typeof act.metadata?.icon === 'string' ? act.metadata.icon : undefined}
                iconKind={typeof act.metadata?.icon === 'string' ? undefined : "document-lines"}
                body={activityPeekBody(act.metadata)}
              />
            {/if}
          </div>
        </div>
      {/each}
    </div>
  {/if}
{:else if groups && showStack && (groups.conversations.length > 0 || groups.events.length > 0 || groups.activities.length > 0)}
  <!-- Grouped period icons: one chat chip for all conversations, one gear for
       all system events, one chip per activity type. Popovers expand the group
       into its items. -->
  <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
  <div class="rail-stack" class:condensed onclick={(e) => e.stopPropagation()}>
    {#if groups.conversations.length > 0}
      {@const msgTotal = groups.conversations.reduce((n, cv) => n + cv.count, 0)}
      <div class="peek-anchor">
        <button class="peek-btn" aria-label="View conversations" onmouseenter={() => reveal("convs")} onfocus={() => reveal("convs")}>
          <Icon kind="chat" />
          {#if groups.conversations.length > 1}<span class="peek-count">{groups.conversations.length}</span>{/if}
        </button>
        <div class="peek-popover">
          {#if revealed.has("convs")}
            <TimelineCard title={groups.conversations.length === 1 ? groups.conversations[0].label : "conversations"} color="blue" iconKind="chat" meta={`${msgTotal} msg${msgTotal === 1 ? '' : 's'}`}>
              <div class="peek-list">
                {#each groups.conversations as conv (conv.id)}
                  {#if isUuid(conv.id)}
                    <button class="peek-list-item peek-list-link" onclick={() => onopenconversation?.(conv)}>
                      <span class="peek-list-label">{conv.label}</span>
                      <span class="peek-list-count">{conv.count} msg{conv.count === 1 ? '' : 's'}</span>
                    </button>
                  {:else}
                    <div class="peek-list-item">
                      <span class="peek-list-label">{conv.label}</span>
                      <span class="peek-list-count">{conv.count} msg{conv.count === 1 ? '' : 's'}</span>
                    </div>
                  {/if}
                {/each}
              </div>
            </TimelineCard>
          {/if}
        </div>
      </div>
    {/if}
    {#if groups.events.length > 0}
      {@const evtTotal = groups.events.reduce((n, ev) => n + ev.count, 0)}
      <div class="peek-anchor">
        <button class="peek-btn" style:color="var(--purple)" aria-label="View system events" onmouseenter={() => reveal("events")} onfocus={() => reveal("events")}>
          <Icon kind="gear" />
          {#if evtTotal > 1}<span class="peek-count">{evtTotal}</span>{/if}
        </button>
        <div class="peek-popover">
          {#if revealed.has("events")}
            <TimelineCard title="system events" color="purple" iconKind="gear" meta={`${evtTotal} event${evtTotal === 1 ? '' : 's'}`}>
              <div class="peek-list">
                {#each groups.events as evt (evt.label)}
                  <div class="peek-list-item">
                    <span class="peek-list-label">{evt.label}</span>
                    {#if evt.count > 1}<span class="peek-list-count">×{evt.count}</span>{/if}
                  </div>
                {/each}
              </div>
            </TimelineCard>
          {/if}
        </div>
      </div>
    {/if}
    {#each groups.activities as group (group.type)}
      {@const groupKey = `group:${group.type}`}
      {@const groupColor = group.color ?? "yellow"}
      {@const groupIcon = group.icon ? sanitizeSvg(group.icon) : ''}
      <div class="peek-anchor">
        <button class="peek-btn" style:color="var(--{groupColor})" aria-label="View activities" onmouseenter={() => reveal(groupKey)} onfocus={() => reveal(groupKey)}>
          {#if groupIcon}
            {@html groupIcon}
          {:else}
            <Icon kind="document-lines" />
          {/if}
          {#if group.count > 1}<span class="peek-count">{group.count}</span>{/if}
        </button>
        <div class="peek-popover">
          {#if revealed.has(groupKey)}
            <TimelineCard title={activityTypeLabel(group.type)} color={groupColor} icon={group.icon} iconKind={group.icon ? undefined : "document-lines"} meta={group.count > group.items.length ? `${group.items.length} of ${group.count}` : `×${group.count}`}>
              <div class="peek-list">
                {#each group.items as actItem (actItem.id)}
                  {@const itemUrl = activityNavUrl(actItem.metadata, mind)}
                  {#if itemUrl}
                    <button class="peek-list-item peek-list-link" onclick={() => navigate(itemUrl)}>
                      <span class="peek-list-label">{actItem.summary}</span>
                      {#if actItem.created_at}<span class="peek-list-count">{formatRelativeTime(actItem.created_at)}</span>{/if}
                    </button>
                  {:else}
                    <div class="peek-list-item">
                      <span class="peek-list-label">{actItem.summary}</span>
                      {#if actItem.created_at}<span class="peek-list-count">{formatRelativeTime(actItem.created_at)}</span>{/if}
                    </div>
                  {/if}
                {/each}
              </div>
            </TimelineCard>
          {/if}
        </div>
      </div>
    {/each}
  </div>
{/if}

<style>
  /* Trigger chip at the marker/dot position. Compound selector so the absolute
     positioning outweighs .peek-anchor's position: relative below. */
  .peek-anchor.rail-trigger {
    position: absolute;
    top: var(--trigger-top, 7px);
    left: var(--rail-x, 50%);
    transform: translateX(-50%);
    z-index: 4;
  }

  /* Icon chips stacked along the rail below the marker */
  .rail-stack {
    position: absolute;
    top: var(--stack-top, 40px);
    left: var(--rail-x, 50%);
    transform: translateX(-50%);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 30px;
    z-index: 4;
  }

  /* Condensed stacks (grouped chips, nested rows) pack tighter */
  .rail-stack.condensed {
    top: var(--stack-top, 34px);
    gap: 12px;
  }

  .peek-anchor {
    position: relative;
  }

  .peek-btn {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    background: var(--bg-1);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--blue);
    cursor: pointer;
    padding: 0;
    transition: background 0.1s, border-color 0.1s;
  }

  .peek-btn :global(svg) {
    width: 10px;
    height: 10px;
  }

  .peek-btn:hover {
    background: var(--bg-2);
    border-color: var(--border-bright);
  }

  /* Count badge on grouped icons */
  .peek-count {
    position: absolute;
    top: -6px;
    right: -8px;
    font-size: 9px;
    line-height: 1;
    padding: 1.5px 3.5px;
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: 999px;
    color: var(--text-1);
    pointer-events: none;
  }

  .peek-popover {
    display: none;
    position: absolute;
    top: -4px;
    left: calc(100% + 8px);
    z-index: 20;
    min-width: 280px;
    max-width: 400px;
    cursor: pointer;
    /* Invisible bridge from button to popover so hover persists */
    padding-left: 12px;
    margin-left: -12px;
    --card-max-height: 340px;
  }

  .peek-popover :global(.timeline-card) {
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
  }

  /* Hover peeks keep the old fixed preview height */
  .peek-popover :global(.page-preview) {
    height: 200px;
  }

  .peek-anchor:hover .peek-popover {
    display: block;
  }

  .peek-msgs {
    padding: 8px 10px;
    max-height: 300px;
    overflow-y: auto;
  }

  .peek-msg {
    padding: 2px 0;
    font-family: var(--mono);
    font-size: 13px;
    color: var(--text-0);
    line-height: 1.5;
  }

  .peek-msg-sender {
    font-weight: 600;
    color: var(--accent);
    margin-right: 6px;
    font-size: 12px;
  }

  .peek-msg-sender-user {
    color: var(--blue);
  }

  .peek-msg-md :global(p) {
    margin: 0;
    display: inline;
  }

  /* Grouped-icon popover: list of items within the group */
  .peek-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 6px 8px;
    max-height: 300px;
    overflow-y: auto;
  }

  .peek-list-item {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 10px;
    width: 100%;
    padding: 3px 4px;
    background: none;
    border: none;
    border-radius: var(--radius);
    font-size: 12px;
    color: var(--text-0);
    text-align: left;
  }

  .peek-list-link {
    cursor: pointer;
  }

  .peek-list-link:hover {
    background: var(--bg-2);
  }

  .peek-list-label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .peek-list-count {
    flex-shrink: 0;
    font-size: 11px;
    color: var(--text-2);
    white-space: nowrap;
  }
</style>
