<script lang="ts">
import type { ContentBlock, Message, Mind, Site } from "@volute/api";
import History from "../components/History.svelte";
import MindInfo from "../components/MindInfo.svelte";
import MindSkills from "../components/MindSkills.svelte";
import NoteCard from "../components/NoteCard.svelte";
import PageThumbnail from "../components/PageThumbnail.svelte";
import PublicFiles from "../components/PublicFiles.svelte";
import StatusBadge from "../components/StatusBadge.svelte";
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
  section?: string;
  onSelectNote: (author: string, slug: string) => void;
} = $props();

let mind = $derived(data.minds.find((m) => m.name === name));

let site = $derived(data.sites.find((s) => s.name === name));

// Find DM conversation with this mind (check mind_name first, then participants)
let dmConv = $derived.by(() => {
  const byName = data.conversations.find((c) => c.type !== "channel" && c.mind_name === name);
  if (byName) return byName;
  return data.conversations.find((c) => {
    if (c.type === "channel") return false;
    const parts = c.participants ?? [];
    if (parts.length !== 2) return false;
    return parts.some((p) => p.username === name);
  });
});

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
let chatScrollEl = $state<HTMLDivElement | undefined>();

// Mixed feed of notes and pages sorted by date
type FeedItem =
  | { kind: "note"; note: ApiNote; date: string }
  | { kind: "page"; file: string; modified: string; date: string };

let feedItems = $derived.by(() => {
  const items: FeedItem[] = [];
  for (const note of recentNotes) {
    items.push({ kind: "note", note, date: note.created_at });
  }
  if (site) {
    for (const page of site.pages.slice(0, 4)) {
      items.push({ kind: "page", file: page.file, modified: page.modified, date: page.modified });
    }
  }
  items.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  return items;
});

$effect(() => {
  const conv = dmConv;
  if (!conv) {
    recentMessages = [];
    return;
  }
  fetchConversationMessages(conv.id, { limit: 10 })
    .then((res) => {
      recentMessages = res.items;
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
  fetch(`/api/ext/notes?author=${encodeURIComponent(mindName)}&limit=6`)
    .then((r) => (r.ok ? r.json() : []))
    .then((notes: ApiNote[]) => {
      recentNotes = notes;
    })
    .catch(() => {
      recentNotes = [];
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
    {#if section === "info"}
      <div class="info-split">
        <div class="info-left">
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
          </div>

          <!-- Chat viewport -->
          <div class="chat-viewport">
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
            <button class="chat-open-btn" onclick={handleChatClick}>
              Open chat &rarr;
            </button>
          </div>

          <!-- Mixed notes & pages feed -->
          {#if feedItems.length > 0}
            <div class="feed-grid">
              {#each feedItems as item (item.kind === "note" ? `note-${item.note.slug}` : `page-${item.file}`)}
                {#if item.kind === "note"}
                  <div class="feed-item">
                    <NoteCard
                      title={item.note.title}
                      author={item.note.author_username}
                      slug={item.note.slug}
                      excerpt={item.note.content.length > 120 ? `${item.note.content.slice(0, 120)}...` : item.note.content}
                      commentCount={item.note.comment_count}
                      createdAt={item.note.created_at}
                      replyTo={item.note.reply_to}
                      reactions={item.note.reactions}
                      onSelect={onSelectNote}
                    />
                  </div>
                {:else}
                  <div class="feed-item">
                    <PageThumbnail
                      url="/pages/{name}/{item.file}"
                      label={item.file}
                      sublabel={formatRelativeTime(item.modified)}
                      onclick={() => handleSelectPage(name, item.file)}
                    />
                  </div>
                {/if}
              {/each}
            </div>
          {/if}
        </div>

        <div class="info-right">
          <History {name} />
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
    {:else if section?.startsWith("ext:")}
      {@const extParts = section.split(":")}
      <div class="section-content">
        <iframe src="/ext/{extParts[1]}/mind/{name}/" class="ext-iframe" title="Extension"></iframe>
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
    padding-bottom: 16px;
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

  /* Split layout — history on right spans full height */
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
    background: var(--bg-1);
    border-left: 1px solid var(--border);
    margin: -24px -24px -24px 0;
    padding: 16px;
  }

  /* Chat viewport */
  .chat-viewport {
    background: var(--bg-0);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    display: flex;
    flex-direction: column;
    max-height: 340px;
    min-height: 80px;
    overflow: hidden;
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
    flex: 1;
  }

  .chat-open-btn {
    display: block;
    width: 100%;
    padding: 8px;
    background: var(--accent-dim);
    color: var(--accent);
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    border-top: 1px solid var(--border);
    text-align: center;
    flex-shrink: 0;
    transition: background 0.15s;
  }

  .chat-open-btn:hover {
    background: var(--accent-bg);
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

  /* Mixed feed grid */
  .feed-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
    gap: 16px;
  }

  .feed-item {
    min-width: 0;
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
