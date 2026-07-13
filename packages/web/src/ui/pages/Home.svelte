<script lang="ts">
import type { ConversationWithParticipants, FeedChatEvent, FeedEvent } from "@volute/api";
import { icons } from "@volute/ui/icons";
import { renderMarkdown } from "@volute/ui/markdown";
import ExtensionFeedCard from "../components/ExtensionFeedCard.svelte";
import ChatEventCard from "../components/home/ChatEventCard.svelte";
import LifecycleRow from "../components/home/LifecycleRow.svelte";
import MindPresenceStrip from "../components/home/MindPresenceStrip.svelte";
import MindEmptyState from "../components/MindEmptyState.svelte";
import ReadOnlyChatModal from "../components/modals/ReadOnlyChatModal.svelte";
import { fetchFeed, fetchFeedDigest } from "../lib/client";
import { normalizeTimestamp } from "../lib/format";
import { navigate } from "../lib/navigate";
import { showMindOnboarding } from "../lib/onboarding";
import { data as storeData } from "../lib/stores.svelte";

let {
  username,
  onSeed,
}: {
  username: string;
  // `conversations` and `onSelectConversation` are part of the shared page
  // signature (MainFrame passes them); the feed sources its own data.
  conversations?: unknown;
  onSelectConversation?: (id: string) => void;
  onSeed?: () => void;
} = $props();

// Fresh-install state: no regular minds yet. Onboarding takes over the landing.
let onboarding = $derived(showMindOnboarding(storeData.minds, storeData.mindsLoaded));

type ExtFeedItem = {
  id: string;
  title: string;
  url: string;
  date: string;
  author?: string;
  bodyHtml: string;
  iframeUrl?: string;
  icon?: string;
  color?: string;
  extensionId: string;
};

let feedEvents = $state<FeedEvent[]>([]);
let extensionFeedItems = $state<ExtFeedItem[]>([]);
let digest = $state("");
let openEvent = $state<FeedChatEvent | null>(null);

// Fetch the system feed (conversation bursts + lifecycle rows).
$effect(() => {
  fetchFeed()
    .then((res) => {
      feedEvents = res.events;
    })
    .catch((err) => {
      console.warn("Failed to fetch feed:", err);
    });
});

// Fetch the AI daily digest header.
$effect(() => {
  fetchFeedDigest()
    .then((res) => {
      digest = res.content;
    })
    .catch((err) => {
      console.warn("Failed to fetch digest:", err);
    });
});

// Fetch extension feed items from all extensions with feedSource
$effect(() => {
  const extensions = storeData.extensions;
  const items: ExtFeedItem[] = [];
  const promises = extensions
    .filter((ext) => ext.feedSource)
    .map(async (ext) => {
      try {
        const res = await fetch(ext.feedSource!.endpoint);
        if (!res.ok) return;
        const feedItems = await res.json();
        for (const item of feedItems) {
          items.push({ ...item, extensionId: ext.id });
        }
      } catch (err) {
        console.warn(`Failed to fetch ${ext.id} feed:`, err);
      }
    });
  Promise.all(promises).then(() => {
    extensionFeedItems = items;
  });
});

function mindLabel(name: string): string {
  return storeData.minds.find((m) => m.name === name)?.displayName ?? name;
}

type SproutItem = { id: number; mind: string; date: string };

type HomeItem =
  | { kind: "chat"; event: FeedChatEvent; date: string }
  | { kind: "lifecycle"; event: Extract<FeedEvent, { kind: "lifecycle" }>; date: string }
  | { kind: "extension"; item: ExtFeedItem; date: string }
  | { kind: "sprout"; item: SproutItem; date: string };

// Sprout events surface as their own home-feed card (#665). They're read from
// the live activity stream (populated by the SSE snapshot + events), so a mind
// leaving the seed stage shows up here without a bespoke fetch.
let sproutItems = $derived(
  storeData.activity
    .filter((a) => a.type === "mind_sprouted")
    .map((a) => ({ id: a.id, mind: a.mind, date: a.created_at })),
);

let items = $derived.by(() => {
  const out: HomeItem[] = [];
  for (const ev of feedEvents) {
    if (ev.kind === "chat") out.push({ kind: "chat", event: ev, date: ev.endedAt });
    else out.push({ kind: "lifecycle", event: ev, date: ev.createdAt });
  }
  for (const ext of extensionFeedItems) {
    out.push({ kind: "extension", item: ext, date: ext.date });
  }
  for (const sprout of sproutItems) {
    out.push({ kind: "sprout", item: sprout, date: sprout.date });
  }
  out.sort((a, b) => {
    const at = new Date(normalizeTimestamp(a.date)).getTime();
    const bt = new Date(normalizeTimestamp(b.date)).getTime();
    return bt - at;
  });
  return out;
});

// Synthesize a conversation prop for the read-only modal from the clicked event.
let openConversation = $derived.by<ConversationWithParticipants | null>(() => {
  if (!openEvent) return null;
  return {
    id: openEvent.conversationId,
    type: openEvent.conversationType,
    user_id: null,
    private: 0,
    created_at: openEvent.startedAt,
    updated_at: openEvent.endedAt,
    channel_name: openEvent.channelName,
    participants: openEvent.participants,
  };
});

let canChat = $derived(openEvent?.participants.some((p) => p.username === username) ?? false);
</script>

<div class="home">
  {#if onboarding}
    <MindEmptyState minds={storeData.minds} onSeed={onSeed ?? (() => {})} />
  {:else}
    <MindPresenceStrip />

    {#if digest.trim()}
      <div class="digest markdown-body">{@html renderMarkdown(digest)}</div>
    {/if}

    {#if items.length === 0}
      <div class="empty-hint">
        Nothing here yet. When your minds do things on their own, it shows up here.
      </div>
    {:else}
      <div class="feed-grid">
        {#each items as item (item.kind === "extension" ? `ext-${item.item.id}` : item.kind === "sprout" ? `sprout-${item.item.id}` : item.kind === "lifecycle" ? `life-${item.event.id}` : `chat-${item.event.conversationId}-${item.event.endedAt}`)}
          {#if item.kind === "extension"}
            <div class="feed-item">
              <ExtensionFeedCard
                title={item.item.title}
                url={item.item.url}
                date={item.item.date}
                author={item.item.author}
                bodyHtml={item.item.bodyHtml}
                iframeUrl={item.item.iframeUrl}
                icon={item.item.icon}
                color={item.item.color}
                onclick={() => navigate(item.item.url)}
              />
            </div>
          {:else if item.kind === "sprout"}
            {@const sprout = item.item}
            <div class="feed-item">
              <ExtensionFeedCard
                title={`${mindLabel(sprout.mind)} sprouted`}
                url={`/minds/${sprout.mind}`}
                date={sprout.date}
                bodyHtml="Left the seed stage and became a full mind — joined #system and began its first week."
                icon={icons.mind}
                color="green"
                onclick={() => navigate(`/minds/${sprout.mind}`)}
              />
            </div>
          {:else if item.kind === "lifecycle"}
            <div class="feed-lifecycle">
              <LifecycleRow event={item.event} />
            </div>
          {:else}
            <div class="feed-item">
              <ChatEventCard event={item.event} onclick={() => { openEvent = item.event; }} />
            </div>
          {/if}
        {/each}
      </div>
    {/if}
  {/if}
</div>

{#if openEvent && openConversation}
  <ReadOnlyChatModal
    conversation={openConversation}
    {canChat}
    onClose={() => { openEvent = null; }}
  />
{/if}

<style>
  .home {
    animation: fadeIn 0.2s ease both;
  }

  .digest {
    color: var(--text-1);
    font-size: 14px;
    line-height: 1.6;
    margin: 0 0 20px;
    padding: 14px 16px;
    background: var(--bg-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
  }

  .empty-hint {
    color: var(--text-2);
    font-size: 13px;
    padding: 40px 0;
    text-align: center;
  }

  .feed-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
    gap: 16px;
    align-items: start;
  }

  .feed-item {
    min-width: 0;
  }

  .feed-lifecycle {
    grid-column: 1 / -1;
  }
</style>
