<script lang="ts">
import type { ConversationWithParticipants, Mind } from "@volute/api";
import type { Selection } from "../../lib/navigate";
import Home from "../../pages/Home.svelte";
import MindPage from "../../pages/MindPage.svelte";
import SystemSettingsPage from "../../pages/SystemSettingsPage.svelte";
import Chat from "../chat/Chat.svelte";
import PublicFiles from "../system/PublicFiles.svelte";
import TurnTimeline from "../TurnTimeline.svelte";

let {
  selection,
  minds,
  conversations,
  username,
  initialSpiritConversationId,
  onConversationId,
  onOpenMind,
  onSelectConversation,
  onTypingNames,
  onToggleSidebar,
  onOpenRightPanel,
}: {
  selection: Selection;
  minds: Mind[];
  conversations: ConversationWithParticipants[];
  username: string;
  initialSpiritConversationId?: string | null;
  onConversationId: (id: string) => void;
  onOpenMind: (mind: Mind) => void;
  onSelectConversation: (id: string) => void;
  onTypingNames?: (names: string[]) => void;
  onToggleSidebar?: () => void;
  onOpenRightPanel?: () => void;
} = $props();

// For channel views, resolve conversation from slug
let channelConv = $derived.by(() => {
  if (selection.kind !== "channel") return undefined;
  return conversations.find((c) => c.type === "channel" && c.name === selection.slug);
});

let channelMindName = $derived.by(() => {
  if (!channelConv) return "";
  return channelConv.mind_name ?? "";
});

// For mind chat views, resolve the DM conversation ID
let mindConversationId = $derived.by(() => {
  if (selection.kind !== "mind") return null;
  const conv = conversations.find((c) => {
    if (c.type === "channel") return false;
    const parts = c.participants ?? [];
    if (parts.length !== 2) return false;
    return parts.some((p) => p.username === selection.name);
  });
  return conv?.id ?? null;
});

let contextLabel = $derived.by(() => {
  if (selection.kind === "channel" && channelConv) {
    return `#${channelConv.name ?? ""}`;
  }
  if (selection.kind === "mind") {
    const mind = minds.find((m) => m.name === selection.name);
    return mind?.displayName ?? selection.name;
  }
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

  {#if selection.kind === "mind"}
    <div class="frame-content mind-frame">
      <MindPage
        name={selection.name}
        section={selection.section}
        subpath={selection.subpath}
        {username}
        conversationId={mindConversationId}
        {onConversationId}
        {minds}
        {conversations}
        {onSelectConversation}
        {onOpenMind}
        {onTypingNames}
      />
    </div>
  {:else if selection.kind === "channel"}
    <div class="frame-content">
      {#if channelConv}
        <Chat
          name={channelMindName}
          {username}
          conversationId={channelConv.id}
          {onConversationId}
          convType="channel"
          channelName={channelConv.name ?? ""}
          {minds}
          participants={channelConv.participants ?? []}
          {onOpenMind}
          {onTypingNames}
        />
      {:else}
        <div class="frame-content padded">
          <div class="not-found">Channel not found.</div>
        </div>
      {/if}
    </div>
  {:else if selection.kind === "extension"}
    <div class="frame-content">
      <iframe src="/ext/{selection.extensionId}/#{selection.path ? '/' + selection.path : ''}" class="page-iframe" title="Extension"></iframe>
    </div>
  {:else if selection.kind === "system-chat"}
    {@const spiritConv = conversations.find((c) => {
      if (c.type === "channel") return false;
      const parts = c.participants ?? [];
      return parts.length === 2 && parts.some((p) => p.username === "volute");
    })}
    <div class="frame-content mind-frame">
      <Chat
        name="volute"
        {username}
        conversationId={spiritConv?.id ?? initialSpiritConversationId ?? null}
        {onConversationId}
        convType="dm"
        {minds}
        participants={spiritConv?.participants ?? []}
        {onOpenMind}
        {onTypingNames}
      />
    </div>
  {:else if selection.kind === "system-history"}
    <div class="frame-content mind-frame">
      <TurnTimeline />
    </div>
  {:else if selection.kind === "settings"}
    <div class="frame-content">
      <SystemSettingsPage section={selection.section} />
    </div>
  {:else if selection.kind === "shared-files"}
    <div class="frame-content">
      <PublicFiles name="_system" rootLabel="shared" />
    </div>
  {:else}
    <div class="frame-content padded">
      <Home {username} {conversations} {onSelectConversation} />
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
    overflow: hidden;
  }

  .page-iframe {
    width: 100%;
    height: 100%;
    border: none;
    background: white;
  }

  .not-found {
    color: var(--text-2);
    font-size: 13px;
    padding: 40px 0;
    text-align: center;
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
