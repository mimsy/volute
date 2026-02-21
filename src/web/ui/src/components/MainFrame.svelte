<script lang="ts">
import type { ConversationWithParticipants, Mind, RecentPage } from "../lib/api";
import type { Selection } from "../lib/navigate";
import Home from "../pages/Home.svelte";
import MindDetail from "../pages/MindDetail.svelte";
import Chat from "./Chat.svelte";

let {
  selection,
  minds,
  conversations,
  recentPages,
  username,
  onConversationId,
}: {
  selection: Selection;
  minds: Mind[];
  conversations: ConversationWithParticipants[];
  recentPages: RecentPage[];
  username: string;
  onConversationId: (id: string) => void;
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
</script>

<div class="main-frame">
  {#if selection.kind === "mind" && selection.name}
    {#key selection.name}
      <div class="frame-content padded">
        <MindDetail name={selection.name} />
      </div>
    {/key}
  {:else if selection.kind === "conversation"}
    <div class="frame-content">
      <Chat
        name={chatMindName}
        {username}
        {conversationId}
        {onConversationId}
        stage={chatMind?.stage}
        convType={chatConvType}
      />
    </div>
  {:else}
    <div class="frame-content padded">
      <Home {username} {minds} {conversations} {recentPages} />
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
</style>
