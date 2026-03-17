<script lang="ts">
import type { ConversationWithParticipants, Mind } from "@volute/api";
import Chat from "../components/Chat.svelte";
import MindInfo from "../components/MindInfo.svelte";
import MindSkills from "../components/MindSkills.svelte";
import PublicFiles from "../components/PublicFiles.svelte";
import TurnTimeline from "../components/TurnTimeline.svelte";
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
    {#if section === "chat" || !section}
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
    {:else if section === "info"}
      <TurnTimeline {name} />
    {:else if section?.startsWith("ext:")}
      {@const extParts = section.split(":")}
      <div class="section-content">
        {#if subpath && extParts[1] === "pages"}
          <iframe src="/ext/{extParts[1]}/public/{name}/{subpath}" class="ext-iframe page-content-iframe" title="Page content"></iframe>
        {:else}
          <iframe src="/ext/{extParts[1]}/#/mind/{name}{subpath ? '/' + subpath : ''}" class="ext-iframe" title="Extension"></iframe>
        {/if}
      </div>
    {:else if section === "files"}
      <div class="section-content files-section">
        <PublicFiles {name} />
      </div>
    {:else if section === "settings"}
      <div class="section-content">
        <MindInfo {mind} />
        <div class="detail-section">
          <MindSkills {name} />
        </div>
      </div>
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

  /* Other sections */
  .section-content {
    flex: 1;
    min-height: 0;
    overflow: auto;
  }

  .files-section {
    min-height: 300px;
  }

  .detail-section {
    margin-top: 24px;
    padding-top: 24px;
    border-top: 1px solid var(--border);
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
