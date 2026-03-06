<script lang="ts">
import type {
  ActivityItem,
  ConversationWithParticipants,
  Mind,
  RecentPage,
  Site,
} from "@volute/api";
import type { Selection } from "../lib/navigate";
import Home from "../pages/Home.svelte";
import PagesDashboard from "../pages/PagesDashboard.svelte";
import SiteView from "../pages/SiteView.svelte";
import Chat from "./Chat.svelte";

let {
  selection,
  minds,
  conversations,
  recentPages,
  sites,
  activity,
  username,
  onConversationId,
  onOpenMind,
  onSelectPage,
  onSelectSite,
  onSelectPages,
  onSelectConversation,
  onTypingNames,
  onToggleSidebar,
  onOpenRightPanel,
}: {
  selection: Selection;
  minds: Mind[];
  conversations: ConversationWithParticipants[];
  recentPages: RecentPage[];
  sites: Site[];
  activity: ActivityItem[];
  username: string;
  onConversationId: (id: string) => void;
  onOpenMind: (mind: Mind) => void;
  onSelectPage: (mind: string, path: string) => void;
  onSelectSite: (name: string) => void;
  onSelectPages: () => void;
  onSelectConversation: (id: string) => void;
  onTypingNames?: (names: string[]) => void;
  onToggleSidebar?: () => void;
  onOpenRightPanel?: () => void;
} = $props();

let selectedSite = $derived(
  selection.kind === "site" ? sites.find((s) => s.name === selection.name) : undefined,
);

let chatMindName = $derived.by(() => {
  if (selection.kind !== "conversation") return "";
  if (selection.mindName) return selection.mindName;
  const conv = conversations.find((c) => c.id === selection.conversationId);
  if (conv?.type === "channel") return "";
  return conv?.mind_name ?? "";
});

let chatMind = $derived(chatMindName ? minds.find((m) => m.name === chatMindName) : undefined);

let chatConvType = $derived.by(() => {
  if (selection.kind !== "conversation") return "dm";
  const conv = conversations.find((c) => c.id === selection.conversationId);
  return conv?.type ?? "dm";
});

let conversationId = $derived(
  selection.kind === "conversation" ? (selection.conversationId ?? null) : null,
);

let chatChannelName = $derived.by(() => {
  if (selection.kind !== "conversation") return "";
  const conv = conversations.find((c) => c.id === selection.conversationId);
  return conv?.type === "channel" ? (conv.name ?? "") : "";
});

let chatParticipants = $derived.by(() => {
  if (selection.kind !== "conversation") return [];
  const conv = conversations.find((c) => c.id === selection.conversationId);
  return conv?.participants ?? [];
});
</script>

<div class="main-frame">
  <div class="mobile-header">
    <button class="hamburger-btn" onclick={() => onToggleSidebar?.()}>&#9776;</button>
    <span class="mobile-title">Volute</span>
    {#if onOpenRightPanel}
      <button class="info-btn" onclick={onOpenRightPanel}>&#9432;</button>
    {/if}
  </div>
  {#if selection.kind === "page"}
    <div class="breadcrumbs">
      <button class="breadcrumb-link" onclick={onSelectPages}>Pages</button>
      <span class="breadcrumb-sep">/</span>
      <button class="breadcrumb-link" onclick={() => onSelectSite(selection.mind)}>{selection.mind}</button>
      <span class="breadcrumb-sep">/</span>
      <span class="breadcrumb-current">{selection.path}</span>
    </div>
    <div class="frame-content">
      <iframe src="/pages/{selection.mind}/{selection.path}" class="page-iframe" title="Page"></iframe>
    </div>
  {:else if selection.kind === "pages"}
    <div class="breadcrumbs">
      <span class="breadcrumb-current">Pages</span>
    </div>
    <div class="frame-content padded">
      <PagesDashboard {sites} {recentPages} {onSelectSite} {onSelectPage} />
    </div>
  {:else if selection.kind === "site" && selectedSite}
    <div class="breadcrumbs">
      <button class="breadcrumb-link" onclick={onSelectPages}>Pages</button>
      <span class="breadcrumb-sep">/</span>
      <span class="breadcrumb-current">{selectedSite.name}</span>
    </div>
    <div class="frame-content padded">
      <SiteView site={selectedSite} {onSelectPage} />
    </div>
  {:else if selection.kind === "conversation"}
    <div class="frame-content">
      <Chat
        name={chatMindName}
        {username}
        {conversationId}
        {onConversationId}
        stage={chatMind?.stage}
        convType={chatConvType}
        channelName={chatChannelName}
        {minds}
        participants={chatParticipants}
        {onOpenMind}
        {onTypingNames}
      />
    </div>
  {:else}
    <div class="frame-content padded">
      <Home {username} {minds} {conversations} {recentPages} {activity} {onOpenMind} {onSelectPage} {onSelectConversation} />
    </div>
  {/if}
</div>

<style>
  .main-frame {
    height: 100%;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }

  .frame-content {
    flex: 1;
    overflow: auto;
    min-height: 0;
  }

  .frame-content.padded {
    padding: 24px;
  }

  .breadcrumbs {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 16px;
    font-family: var(--font-mono, monospace);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-2);
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }

  .breadcrumb-link {
    background: none;
    border: none;
    padding: 0;
    font: inherit;
    text-transform: inherit;
    letter-spacing: inherit;
    color: var(--text-1);
    cursor: pointer;
  }

  .breadcrumb-link:hover {
    color: var(--accent);
  }

  .breadcrumb-sep {
    color: var(--text-2);
  }

  .breadcrumb-current {
    color: var(--text-2);
  }

  .page-iframe {
    width: 100%;
    height: 100%;
    border: none;
    background: white;
  }

  .mobile-header {
    display: none;
    align-items: center;
    gap: 10px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
    background: var(--bg-1);
  }

  .hamburger-btn {
    background: none;
    border: none;
    color: var(--text-1);
    font-size: 18px;
    padding: 4px 8px;
    border-radius: var(--radius);
    cursor: pointer;
  }

  .hamburger-btn:hover {
    background: var(--bg-2);
  }

  .mobile-title {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-1);
    flex: 1;
  }

  .info-btn {
    background: none;
    border: none;
    color: var(--text-2);
    font-size: 18px;
    padding: 4px 8px;
    border-radius: var(--radius);
    cursor: pointer;
    flex-shrink: 0;
  }

  .info-btn:hover {
    background: var(--bg-2);
    color: var(--text-1);
  }

  @media (max-width: 1024px) {
    .mobile-header {
      display: flex;
    }
  }

  @media (max-width: 767px) {
    .frame-content.padded {
      padding: 16px;
    }
  }
</style>
