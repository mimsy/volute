<script lang="ts">
import type { ConversationWithParticipants, Mind, RecentPage } from "../lib/api";
import type { Selection } from "../lib/navigate";
import Home from "../pages/Home.svelte";
import Chat from "./Chat.svelte";

let {
  selection,
  minds,
  conversations,
  recentPages,
  username,
  onConversationId,
  onOpenMind,
  onSelectPage,
}: {
  selection: Selection;
  minds: Mind[];
  conversations: ConversationWithParticipants[];
  recentPages: RecentPage[];
  username: string;
  onConversationId: (id: string) => void;
  onOpenMind: (mind: Mind) => void;
  onSelectPage: (mind: string, path: string) => void;
} = $props();

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
</script>

<div class="main-frame">
  {#if selection.kind === "page"}
    <div class="frame-content">
      <iframe src="/pages/{selection.mind}/{selection.path}" class="page-iframe" title="Page"></iframe>
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
      />
    </div>
  {:else}
    <div class="frame-content padded">
      <Home {username} {minds} {conversations} {recentPages} {onOpenMind} {onSelectPage} />
    </div>
  {/if}
</div>

<style>
  .main-frame {
    height: 100%;
    overflow: hidden;
  }

  .frame-content {
    height: 100%;
    overflow: auto;
  }

  .frame-content.padded {
    padding: 24px;
  }

  .page-iframe {
    width: 100%;
    height: 100%;
    border: none;
  }
</style>
