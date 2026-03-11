<script lang="ts">
import type { ContentBlock, Message, Mind } from "@volute/api";
import History from "../components/History.svelte";
import MindInfo from "../components/MindInfo.svelte";
import MindSkills from "../components/MindSkills.svelte";
import NoteCard from "../components/NoteCard.svelte";
import PublicFiles from "../components/PublicFiles.svelte";
import StatusBadge from "../components/StatusBadge.svelte";
import VariantList from "../components/VariantList.svelte";
import { fetchConversationMessages } from "../lib/client";
import { formatRelativeTime, getDisplayStatus } from "../lib/format";
import { renderMarkdown } from "../lib/markdown";
import { navigate } from "../lib/navigate";
import { data } from "../lib/stores.svelte";
import Notes from "./Notes.svelte";
import SiteView from "./SiteView.svelte";

let {
  name,
  section = "info",
  onSelectNote,
}: {
  name: string;
  section?: "info" | "notes" | "pages" | "files" | "settings";
  onSelectNote: (author: string, slug: string) => void;
} = $props();

let mind = $derived(data.minds.find((m) => m.name === name));

let connectedChannels = $derived(
  mind ? mind.channels.filter((ch) => ch.name !== "web" && ch.status === "connected") : [],
);

let site = $derived(data.sites.find((s) => s.name === name));

// Find DM conversation with this mind (check mind_name first, then participants)
let dmConv = $derived.by(() => {
  // Try mind_name first
  const byName = data.conversations.find((c) => c.type !== "channel" && c.mind_name === name);
  if (byName) return byName;
  // Fall back to 2-person conversation where the other participant is this mind
  return data.conversations.find((c) => {
    if (c.type === "channel") return false;
    const parts = c.participants ?? [];
    if (parts.length !== 2) return false;
    return parts.some((p) => p.username === name);
  });
});

// Recent messages from DM
interface ApiNote {
  title: string;
  author_username: string;
  slug: string;
  content: string;
  comment_count: number;
  created_at: string;
  reply_to?: { author_username: string; slug: string; title: string } | null;
  reactions?: { emoji: string; count: number }[];
}

let recentMessages = $state<Message[]>([]);
let recentNotes = $state<ApiNote[]>([]);
let recentFiles = $state<{ name: string; type: string }[]>([]);
let chatScrollEl = $state<HTMLDivElement | undefined>();

$effect(() => {
  const conv = dmConv;
  if (!conv) {
    recentMessages = [];
    return;
  }
  fetchConversationMessages(conv.id, { limit: 20 })
    .then((res) => {
      recentMessages = res.items.reverse();
      // Scroll to bottom after messages load
      requestAnimationFrame(() => {
        if (chatScrollEl) chatScrollEl.scrollTop = chatScrollEl.scrollHeight;
      });
    })
    .catch(() => {
      recentMessages = [];
    });
});

$effect(() => {
  const mindName = name;
  fetch(`/api/notes?author=${encodeURIComponent(mindName)}&limit=3`)
    .then((r) => (r.ok ? r.json() : []))
    .then((notes: ApiNote[]) => {
      recentNotes = notes;
    })
    .catch(() => {
      recentNotes = [];
    });
});

$effect(() => {
  const mindName = name;
  fetch(`/public/${encodeURIComponent(mindName)}/`)
    .then((r) => (r.ok ? r.json() : []))
    .then((entries: { name: string; type: string }[]) => {
      recentFiles = entries.filter((e) => e.type === "file").slice(0, 5);
    })
    .catch(() => {
      recentFiles = [];
    });
});

function formatCreated(dateStr: string): string {
  try {
    const d = new Date(dateStr.endsWith("Z") ? dateStr : `${dateStr}Z`);
    return d.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
  } catch {
    return dateStr;
  }
}

function formatTime(dateStr: string): string {
  try {
    const d = new Date(dateStr.endsWith("Z") ? dateStr : `${dateStr}Z`);
    return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  } catch {
    return "";
  }
}

function handleChatClick() {
  if (dmConv) {
    navigate(`/chat/${dmConv.id}`);
  } else {
    navigate(`/chat?mind=${name}`);
  }
}

function handleSelectPage(mind: string, path: string) {
  navigate(`/pages/${mind}/${path}`);
}

function showSenderHeader(i: number): boolean {
  if (i === 0) return true;
  const prev = recentMessages[i - 1];
  const cur = recentMessages[i];
  return (prev.sender_name ?? prev.role) !== (cur.sender_name ?? cur.role);
}

function extractTextContent(content: ContentBlock[]): string {
  return content
    .filter((b): b is ContentBlock & { type: "text" } => b.type === "text")
    .map((b) => b.text)
    .join("\n\n");
}
</script>

{#if !mind}
  <div class="not-found">Mind "{name}" not found.</div>
{:else}
  <div class="mind-page">
    <!-- Profile header -->
    <div class="profile-header">
      {#if mind.avatar}
        <img
          src={`/api/minds/${encodeURIComponent(mind.name)}/avatar`}
          alt=""
          class="profile-avatar"
        />
      {/if}
      <div class="profile-info">
        <div class="profile-name-row">
          <span class="profile-display-name">{mind.displayName ?? mind.name}</span>
          <StatusBadge status={getDisplayStatus(mind)} />
          {#if mind.stage === "seed"}
            <span class="seed-tag">seed</span>
          {/if}
        </div>
        {#if mind.description}
          <p class="profile-description">{mind.description}</p>
        {/if}
        <span class="profile-meta">@{mind.name} &middot; since {formatCreated(mind.created)}</span>
      </div>
      <button class="chat-btn" onclick={handleChatClick}>Chat</button>
    </div>

    <!-- Section content -->
    {#if section === "info"}
      <div class="info-split">
        <div class="info-left">
          <!-- Recent chat viewport -->
          <div class="chat-viewport">
            <div class="chat-viewport-header">
              <button class="card-link" onclick={handleChatClick}>Open chat &rarr;</button>
            </div>
            {#if recentMessages.length === 0}
              <div class="chat-viewport-empty">No messages yet.</div>
            {:else}
              <!-- svelte-ignore a11y_no_static_element_interactions -->
              <div class="chat-viewport-scroll" bind:this={chatScrollEl} onscroll={(e) => {
                const el = e.currentTarget;
                if (el.scrollTop < 10) el.scrollTop = 10;
              }}>
                {#each recentMessages as msg, i (msg.id)}
                  <div class="chat-entry" class:new-sender={showSenderHeader(i)}>
                    {#if showSenderHeader(i)}
                      <div class="chat-entry-header">
                        <span class="chat-sender" class:chat-sender-user={msg.role === "user"}>{msg.sender_name ?? (msg.role === "user" ? "you" : name)}</span>
                        <span class="chat-timestamp">{formatTime(msg.created_at)}</span>
                      </div>
                    {/if}
                    <div class="chat-entry-content" class:chat-user-text={msg.role === "user"}>
                      {#if msg.role === "user"}
                        {extractTextContent(msg.content)}
                      {:else}
                        <div class="markdown-body">{@html renderMarkdown(extractTextContent(msg.content))}</div>
                      {/if}
                    </div>
                  </div>
                {/each}
              </div>
            {/if}
            <button class="chat-viewport-cta" onclick={handleChatClick}>
              Continue conversation &rarr;
            </button>
          </div>

          <!-- Recent notes -->
          {#if recentNotes.length > 0}
            <div class="card">
              <div class="card-header">
                <span class="card-title">Notes</span>
                <button class="card-link" onclick={() => navigate(`/minds/${name}/notes`)}>All notes &rarr;</button>
              </div>
              <div class="notes-list">
                {#each recentNotes as note (`${note.author_username}/${note.slug}`)}
                  <NoteCard
                    title={note.title}
                    author={note.author_username}
                    slug={note.slug}
                    excerpt={note.content.length > 120 ? `${note.content.slice(0, 120)}...` : note.content}
                    commentCount={note.comment_count}
                    createdAt={note.created_at}
                    replyTo={note.reply_to}
                    reactions={note.reactions}
                    onSelect={onSelectNote}
                  />
                {/each}
              </div>
            </div>
          {/if}

          <!-- Recent files -->
          {#if recentFiles.length > 0}
            <div class="card">
              <div class="card-header">
                <span class="card-title">Files</span>
                <button class="card-link" onclick={() => navigate(`/minds/${name}/files`)}>All files &rarr;</button>
              </div>
              <div class="file-list">
                {#each recentFiles as file (file.name)}
                  <div class="file-row">{file.name}</div>
                {/each}
              </div>
            </div>
          {/if}

          <!-- Pages -->
          {#if site && site.pages.length > 0}
            <div class="card">
              <div class="card-header">
                <span class="card-title">Pages</span>
                <button class="card-link" onclick={() => navigate(`/minds/${name}/pages`)}>All pages &rarr;</button>
              </div>
              <div class="file-list">
                {#each site.pages.slice(0, 5) as page (page.file)}
                  <button class="file-row clickable" onclick={() => handleSelectPage(name, page.file)}>
                    {page.file}
                    <span class="file-time">{formatRelativeTime(page.modified)}</span>
                  </button>
                {/each}
              </div>
            </div>
          {/if}

          <!-- Connections -->
          {#if connectedChannels.length > 0}
            <div class="card">
              <div class="card-title" style="padding: 0 0 8px">Connections</div>
              <div class="connections-list">
                {#each connectedChannels as channel}
                  <div class="connection-row">
                    <span class="connection-name">{channel.displayName}</span>
                    <StatusBadge status="connected" />
                    {#if channel.username}
                      <span class="connection-bot">{channel.username}</span>
                    {/if}
                  </div>
                {/each}
              </div>
            </div>
          {/if}

          <!-- Variants -->
          <div class="card">
            <div class="card-title" style="padding: 0 0 8px">Variants</div>
            <VariantList {name} />
          </div>
        </div>

        <div class="info-right">
          <div class="info-right-scroll">
            <History {name} />
          </div>
        </div>
      </div>
    {:else if section === "notes"}
      <div class="section-content">
        <Notes {onSelectNote} author={name} />
      </div>
    {:else if section === "pages"}
      <div class="section-content">
        {#if site}
          <SiteView {site} onSelectPage={handleSelectPage} />
        {:else}
          <div class="empty-hint">No published pages.</div>
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
  }

  .not-found {
    color: var(--text-2);
    padding: 40px;
    text-align: center;
  }

  .profile-header {
    display: flex;
    align-items: flex-start;
    gap: 16px;
    padding-bottom: 20px;
    border-bottom: 1px solid var(--border);
    margin-bottom: 20px;
    flex-shrink: 0;
  }

  .profile-avatar {
    width: 80px;
    height: 80px;
    border-radius: var(--radius-lg);
    object-fit: cover;
    flex-shrink: 0;
  }

  .profile-info {
    flex: 1;
    min-width: 0;
  }

  .profile-name-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 4px;
  }

  .profile-display-name {
    font-family: var(--display);
    font-size: 24px;
    font-weight: 400;
    color: var(--text-0);
  }

  .seed-tag {
    font-size: 10px;
    color: var(--yellow);
  }

  .profile-description {
    font-size: 14px;
    color: var(--text-1);
    line-height: 1.4;
    margin: 4px 0 0;
  }

  .profile-meta {
    font-size: 12px;
    color: var(--text-2);
    margin-top: 4px;
    display: block;
  }

  .chat-btn {
    flex-shrink: 0;
    padding: 6px 16px;
    border-radius: var(--radius);
    background: var(--accent-dim);
    color: var(--accent);
    border: 1px solid var(--accent-border);
    font-size: 13px;
    cursor: pointer;
    transition: border-color 0.15s;
  }

  .chat-btn:hover {
    border-color: var(--accent);
  }

  /* Split layout */
  .info-split {
    display: flex;
    gap: 24px;
    flex: 1;
    min-height: 0;
  }

  .info-left {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 16px;
    overflow: auto;
  }

  .info-right {
    width: 420px;
    flex-shrink: 0;
    min-height: 0;
  }

  .info-right-scroll {
    height: 100%;
    overflow: auto;
  }

  /* Chat viewport */
  .chat-viewport {
    background: var(--bg-0);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    display: flex;
    flex-direction: column;
    max-height: 360px;
    min-height: 120px;
    overflow: hidden;
  }

  .chat-viewport-header {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    padding: 8px 12px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }

  .chat-viewport-scroll {
    flex: 1;
    overflow: auto;
    padding: 12px 16px;
    min-height: 0;
  }

  .chat-viewport-empty {
    color: var(--text-2);
    font-size: 13px;
    padding: 24px 16px;
    text-align: center;
  }

  .chat-viewport-cta {
    display: block;
    width: 100%;
    padding: 8px;
    background: var(--bg-2);
    color: var(--accent);
    font-size: 12px;
    cursor: pointer;
    border-top: 1px solid var(--border);
    text-align: center;
    flex-shrink: 0;
  }

  .chat-viewport-cta:hover {
    background: var(--bg-3);
  }

  /* Chat entries (matching MessageEntry style) */
  .chat-entry {
    padding: 2px 0;
  }

  .chat-entry.new-sender {
    margin-top: 12px;
  }

  .chat-entry:first-child {
    margin-top: 0;
  }

  .chat-entry-header {
    display: flex;
    align-items: baseline;
    gap: 8px;
    margin-bottom: 2px;
  }

  .chat-sender {
    font-size: 14px;
    font-weight: 600;
    color: var(--accent);
  }

  .chat-sender-user {
    color: var(--blue);
  }

  .chat-timestamp {
    font-size: 12px;
    color: var(--text-2);
  }

  .chat-entry-content {
    min-width: 0;
    font-family: var(--mono);
    font-size: 14px;
  }

  .chat-user-text {
    color: var(--text-0);
    white-space: pre-wrap;
  }

  /* Cards */
  .card {
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: 14px 16px;
  }

  .card-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 10px;
  }

  .card-title {
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-2);
  }

  .card-link {
    background: none;
    color: var(--accent);
    font-size: 12px;
    cursor: pointer;
    padding: 0;
  }

  .card-link:hover {
    text-decoration: underline;
  }

  .card-empty {
    color: var(--text-2);
    font-size: 13px;
    padding: 8px 0;
  }

  /* Notes */
  .notes-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  /* Files */
  .file-list {
    display: flex;
    flex-direction: column;
  }

  .file-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 0;
    font-size: 13px;
    color: var(--text-1);
    background: none;
    text-align: left;
    width: 100%;
  }

  .file-row.clickable {
    cursor: pointer;
  }

  .file-row.clickable:hover {
    color: var(--text-0);
  }

  .file-time {
    margin-left: auto;
    font-size: 11px;
    color: var(--text-2);
  }

  /* Connections */
  .connections-list {
    display: flex;
    flex-direction: column;
  }

  .connection-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 0;
    font-size: 13px;
  }

  .connection-name {
    font-weight: 500;
    color: var(--text-0);
  }

  .connection-bot {
    font-size: 12px;
    color: var(--text-1);
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

  .empty-hint {
    color: var(--text-2);
    font-size: 13px;
    padding: 40px 0;
    text-align: center;
  }

  @media (max-width: 1024px) {
    .info-split {
      flex-direction: column;
    }

    .info-right {
      width: 100%;
    }
  }

  @media (max-width: 767px) {
    .profile-header {
      flex-direction: column;
      align-items: center;
      text-align: center;
    }

    .profile-name-row {
      justify-content: center;
    }
  }
</style>
