<script lang="ts">
import type {
  ActivityItem,
  ConversationWithParticipants,
  Mind,
  RecentPage,
  Site,
} from "@volute/api";
import { navigate, type Selection } from "../lib/navigate";
import ChatHome from "../pages/ChatHome.svelte";
import Home from "../pages/Home.svelte";
import MindPage from "../pages/MindPage.svelte";
import Notes from "../pages/Notes.svelte";
import NoteView from "../pages/NoteView.svelte";
import PagesDashboard from "../pages/PagesDashboard.svelte";
import SiteView from "../pages/SiteView.svelte";
import SystemSettingsPage from "../pages/SystemSettingsPage.svelte";
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
  onSelectNotes,
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
  onSelectNotes: () => void;
  onTypingNames?: (names: string[]) => void;
  onToggleSidebar?: () => void;
  onOpenRightPanel?: () => void;
} = $props();

function handleIframeNav(e: Event) {
  const iframe = e.target as HTMLIFrameElement;
  let path: string | undefined;
  try {
    path = iframe.contentWindow?.location.pathname;
  } catch {
    return; // cross-origin or security error — expected
  }
  if (!path) return;
  const match = path.match(/^\/pages\/([^/]+)\/(.+)$/);
  if (!match) return;
  const [, mind, file] = match;
  // Only update if path actually changed
  if (selection.kind === "mind-page" && selection.mind === mind && selection.path === file) return;
  if (selection.kind === "page" && selection.mind === mind && selection.path === file) return;
  onSelectPage(mind, file);
}

let selectedSite = $derived.by(() => {
  if (selection.kind === "site") return sites.find((s) => s.name === selection.name);
  return undefined;
});

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

let contextLabel = $derived.by(() => {
  if (selection.kind !== "conversation") return "";
  if (chatChannelName) return `#${chatChannelName}`;
  const mind = chatMind ?? (chatMindName ? minds.find((m) => m.name === chatMindName) : undefined);
  if (mind) return mind.displayName ?? mind.name;
  if (chatMindName) return chatMindName;
  return "";
});
</script>

<div class="main-frame">
  <div class="mobile-header">
    <button class="hamburger-btn" onclick={() => onToggleSidebar?.()}>&#9776;</button>
    <img src="/logo.png" alt="" class="mobile-logo" />
    <span class="mobile-title">volute</span>
    {#if contextLabel && onOpenRightPanel}
      <button class="context-label-btn" onclick={onOpenRightPanel}>{contextLabel}</button>
    {/if}
  </div>

  <!-- System tab views -->
  {#if selection.tab === "system"}
    {#if selection.kind === "mind"}
      <div class="frame-content mind-frame">
        <MindPage name={selection.name} section={selection.section} />
      </div>
    {:else if selection.kind === "mind-note"}
      <div class="frame-content padded">
        <NoteView author={selection.mind} slug={selection.slug} {username} onNavigate={(author, slug) => navigate(`/minds/${author}/notes/${slug}`)} />
      </div>
    {:else if selection.kind === "mind-page"}
      <div class="frame-content">
        <iframe src="/pages/{selection.mind}/{selection.path}" class="page-iframe" title="Page" onload={handleIframeNav}></iframe>
      </div>
    {:else if selection.kind === "page"}
      <div class="frame-content">
        <iframe src="/pages/{selection.mind}/{selection.path}" class="page-iframe" title="Page" onload={handleIframeNav}></iframe>
      </div>
    {:else if selection.kind === "pages"}
      <div class="frame-content padded">
        <PagesDashboard {sites} {recentPages} {onSelectSite} {onSelectPage} />
      </div>
    {:else if selection.kind === "site" && selectedSite}
      <div class="frame-content padded">
        <SiteView site={selectedSite} {onSelectPage} />
      </div>
    {:else if selection.kind === "extension"}
      <div class="frame-content">
        <iframe src="/ext/{selection.extensionId}/{selection.path}" class="page-iframe" title="Extension"></iframe>
      </div>
    {:else if selection.kind === "settings"}
      <div class="frame-content">
        <SystemSettingsPage section={selection.section} />
      </div>
    {:else if selection.kind === "notes"}
      <div class="frame-content padded">
        <Notes />
      </div>
    {:else if selection.kind === "note"}
      <div class="frame-content padded">
        <NoteView author={selection.author} slug={selection.slug} {username} onNavigate={(author, slug) => navigate(`/minds/${author}/notes/${slug}`)} />
      </div>
    {:else}
      <div class="frame-content padded">
        <Home {username} {conversations} {sites} {onSelectPage} {onSelectConversation} />
      </div>
    {/if}

  <!-- Chat tab views -->
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
    <div class="frame-content">
      <ChatHome {conversations} {username} {onSelectConversation} />
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

  .frame-content.mind-frame {
    padding: 24px;
    overflow: hidden;
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
    display: none;
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

  .mobile-logo {
    width: 20px;
    height: 20px;
    filter: invert(1);
  }

  .mobile-title {
    font-family: var(--display);
    font-size: 18px;
    font-weight: 300;
    color: var(--text-0);
    letter-spacing: 0.04em;
    margin-left: -4px;
  }

  .context-label-btn {
    margin-left: auto;
    background: none;
    border: none;
    color: var(--text-1);
    font-size: 14px;
    font-weight: 500;
    padding: 4px 0;
    text-align: right;
    cursor: pointer;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .context-label-btn:hover {
    color: var(--accent);
  }

  @media (max-width: 767px) {
    .frame-content.padded {
      padding: 16px;
    }
  }
</style>
