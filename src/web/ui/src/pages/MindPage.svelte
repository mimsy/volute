<script lang="ts">
import type { ConversationWithParticipants, Mind } from "@volute/api";
import Chat from "../components/Chat.svelte";
import { data } from "../lib/stores.svelte";

let {
  name,
  section = "chat",
  subpath,
  username,
  conversationId,
  onConversationId,
  minds,
  conversations,
  onSelectConversation,
  onOpenMind,
  onTypingNames,
}: {
  name: string;
  section?: string;
  subpath?: string;
  username?: string;
  conversationId?: string | null;
  onConversationId?: (id: string) => void;
  minds?: Mind[];
  conversations?: ConversationWithParticipants[];
  onSelectConversation?: (id: string) => void;
  onOpenMind?: (mind: Mind) => void;
  onTypingNames?: (names: string[]) => void;
} = $props();

let mind = $derived(data.minds.find((m) => m.name === name));
</script>

{#if !mind}
  <div class="not-found">Mind "{name}" not found.</div>
{:else}
  <div class="mind-page">
    {#if section?.startsWith("ext:")}
      {@const extParts = section.split(":")}
      <div class="section-content">
        {#if subpath && extParts[1] === "pages"}
          <iframe src="/ext/{extParts[1]}/public/{name}/{subpath}" class="ext-iframe page-content-iframe" title="Page content"></iframe>
        {:else}
          <iframe src="/ext/{extParts[1]}/#/mind/{name}{subpath ? '/' + subpath : ''}" class="ext-iframe" title="Extension"></iframe>
        {/if}
      </div>
    {:else}
      <Chat
        {name}
        {username}
        conversationId={conversationId ?? null}
        onConversationId={onConversationId ?? (() => {})}
        stage={mind.stage}
        minds={minds ?? data.minds}
        {onOpenMind}
        {onTypingNames}
      />
    {/if}
  </div>
{/if}

<style>
  .mind-page {
    animation: fadeIn 0.2s ease both;
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    overflow: hidden;
    position: relative;
  }

  .not-found {
    color: var(--text-2);
    padding: 40px;
    text-align: center;
  }

  .section-content {
    flex: 1;
    min-height: 0;
    overflow: auto;
  }

  .ext-iframe {
    width: 100%;
    height: 100%;
    border: none;
    background: var(--bg-0);
  }

  .page-content-iframe {
    background: white;
  }
</style>
