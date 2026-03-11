<script lang="ts">
import CommentSection from "../components/CommentSection.svelte";

interface Comment {
  id: number;
  author_username: string;
  author_display_name: string | null;
  content: string;
  created_at: string;
}

interface Reaction {
  emoji: string;
  count: number;
  usernames: string[];
}

interface ReplyRef {
  author_username: string;
  slug: string;
  title: string;
}

interface NoteReply {
  author_username: string;
  slug: string;
  title: string;
  created_at: string;
}

interface Note {
  id: number;
  title: string;
  content: string;
  author_username: string;
  author_display_name: string | null;
  slug: string;
  created_at: string;
  updated_at: string;
  comments: Comment[];
  reactions?: Reaction[];
  reply_to?: ReplyRef | null;
  replies?: NoteReply[];
}

let {
  author,
  slug,
  username,
  onNavigate,
}: {
  author: string;
  slug: string;
  username: string;
  onNavigate: (author: string, slug: string) => void;
} = $props();

let note: Note | null = $state(null);
let loading = $state(true);
let notFound = $state(false);
let error = $state("");
let emojiInput = $state("");
let showEmojiInput = $state(false);

function noteUrl(path = "") {
  return `/api/notes/${encodeURIComponent(author)}/${encodeURIComponent(slug)}${path}`;
}

async function fetchNote() {
  loading = true;
  notFound = false;
  error = "";
  note = null;
  try {
    const res = await fetch(noteUrl());
    if (res.status === 404) {
      notFound = true;
    } else if (res.ok) {
      note = await res.json();
    } else {
      error = `Failed to load note (${res.status})`;
    }
  } catch {
    error = "Network error — could not load note";
  } finally {
    loading = false;
  }
}

$effect(() => {
  void author;
  void slug;
  fetchNote();
});

async function handleComment(content: string) {
  try {
    const res = await fetch(noteUrl("/comments"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
    if (!res.ok) {
      error = `Failed to add comment (${res.status})`;
      return;
    }
  } catch {
    error = "Network error — could not add comment";
    return;
  }
  await fetchNote();
}

async function handleDeleteComment(commentId: number) {
  try {
    const res = await fetch(noteUrl(`/comments/${commentId}`), { method: "DELETE" });
    if (!res.ok) {
      error = `Failed to delete comment (${res.status})`;
      return;
    }
  } catch {
    error = "Network error — could not delete comment";
    return;
  }
  await fetchNote();
}

async function toggleReaction(emoji: string) {
  try {
    const res = await fetch(noteUrl("/reactions"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ emoji }),
    });
    if (!res.ok) return;
  } catch {
    return;
  }
  await fetchNote();
}

async function submitEmoji(e: Event) {
  e.preventDefault();
  const emoji = emojiInput.trim();
  if (!emoji) return;
  emojiInput = "";
  showEmojiInput = false;
  await toggleReaction(emoji);
}

function parseDate(s: string): Date {
  return new Date(`${s.replace(" ", "T")}Z`);
}

function formatDate(iso: string): string {
  return parseDate(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function hasReacted(reaction: Reaction): boolean {
  return reaction.usernames.includes(username);
}
</script>

<div class="note-view">
  {#if error}
    <div class="error">{error}</div>
  {/if}

  {#if loading}
    <div class="status">Loading...</div>
  {:else if notFound}
    <div class="status">Note not found.</div>
  {:else if note}
    <article class="note">
      {#if note.reply_to}
        <button class="reply-to-link" onclick={() => onNavigate(note!.reply_to!.author_username, note!.reply_to!.slug)}>
          <span class="reply-arrow">&#8617;</span> In reply to <span class="reply-ref">{note.reply_to.title}</span>
        </button>
      {/if}

      <h1 class="title">{note.title}</h1>

      <div class="meta">
        <span class="author">{note.author_display_name ?? note.author_username}</span>
        <span class="sep">&middot;</span>
        <span class="date">{formatDate(note.created_at)}</span>
      </div>

      <div class="divider"></div>

      <div class="content">{note.content}</div>

      <div class="reactions-bar">
        {#if note.reactions && note.reactions.length > 0}
          {#each note.reactions as reaction}
            <button
              class="reaction-pill"
              class:active={hasReacted(reaction)}
              onclick={() => toggleReaction(reaction.emoji)}
            >
              {reaction.emoji} {reaction.count}
            </button>
          {/each}
        {/if}
        {#if showEmojiInput}
          <form class="emoji-form" onsubmit={submitEmoji}>
            <input
              class="emoji-input"
              bind:value={emojiInput}
              placeholder="emoji"
              maxlength="32"
            />
          </form>
        {:else}
          <button class="reaction-pill add-reaction" onclick={() => { showEmojiInput = true; }}>+</button>
        {/if}
      </div>
    </article>

    {#if note.replies && note.replies.length > 0}
      <div class="replies-section">
        <h3 class="section-title">Replies</h3>
        {#each note.replies as reply}
          <button class="reply-card" onclick={() => onNavigate(reply.author_username, reply.slug)}>
            <span class="reply-title">{reply.title}</span>
            <span class="reply-meta">{reply.author_username} &middot; {formatDate(reply.created_at)}</span>
          </button>
        {/each}
      </div>
    {/if}

    <div class="comments-section">
      <CommentSection
        comments={note.comments}
        onComment={handleComment}
        onDelete={handleDeleteComment}
        currentUsername={username}
      />
    </div>
  {/if}
</div>

<style>
  .note-view {
    max-width: 640px;
    margin: 0 auto;
    animation: fadeIn 0.2s ease both;
  }

  .error {
    font-size: 13px;
    color: var(--red, #e55);
    margin-bottom: 12px;
  }

  .status {
    color: var(--text-2);
    font-size: 14px;
    padding: 32px 0;
    text-align: center;
  }

  .note {
    margin-bottom: 32px;
  }

  .reply-to-link {
    background: none;
    border: none;
    font-size: 13px;
    color: var(--text-2);
    cursor: pointer;
    padding: 0;
    margin-bottom: 16px;
    display: block;
    text-align: left;
  }

  .reply-to-link:hover {
    color: var(--accent);
  }

  .reply-arrow {
    opacity: 0.6;
  }

  .reply-ref {
    color: var(--text-1);
    font-style: italic;
  }

  .reply-to-link:hover .reply-ref {
    color: var(--accent);
  }

  .title {
    font-family: var(--display);
    font-size: 26px;
    font-weight: 400;
    color: var(--text-0);
    margin: 0 0 10px 0;
    line-height: 1.3;
    letter-spacing: -0.01em;
  }

  .meta {
    display: flex;
    align-items: baseline;
    gap: 6px;
    margin-bottom: 0;
  }

  .author {
    font-size: 14px;
    color: var(--text-1);
    font-weight: 500;
  }

  .sep {
    color: var(--text-2);
    font-size: 12px;
  }

  .date {
    font-size: 13px;
    color: var(--text-2);
  }

  .divider {
    height: 1px;
    background: var(--border);
    margin: 16px 0 20px;
  }

  .content {
    font-size: 15px;
    color: var(--text-0);
    line-height: 1.7;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .reactions-bar {
    display: flex;
    gap: 6px;
    margin-top: 20px;
    flex-wrap: wrap;
    align-items: center;
  }

  .reaction-pill {
    font-size: 13px;
    padding: 4px 10px;
    background: var(--bg-3);
    border: 1px solid var(--border);
    border-radius: 14px;
    color: var(--text-1);
    cursor: pointer;
    transition: all 0.15s;
  }

  .reaction-pill:hover {
    border-color: var(--border-bright);
  }

  .reaction-pill.active {
    border-color: var(--accent-border);
    background: var(--accent-dim);
  }

  .add-reaction {
    color: var(--text-2);
    font-size: 14px;
  }

  .emoji-form {
    display: inline-flex;
  }

  .emoji-input {
    width: 60px;
    padding: 4px 8px;
    background: var(--bg-3);
    border: 1px solid var(--border);
    border-radius: 14px;
    color: var(--text-0);
    font-size: 13px;
    outline: none;
  }

  .emoji-input:focus {
    border-color: var(--accent);
  }

  .replies-section {
    border-top: 1px solid var(--border);
    padding-top: 20px;
    margin-bottom: 24px;
  }

  .section-title {
    font-size: 13px;
    font-weight: 500;
    color: var(--text-2);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    margin: 0 0 12px;
  }

  .reply-card {
    display: block;
    width: 100%;
    text-align: left;
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 10px 14px;
    cursor: pointer;
    margin-bottom: 6px;
    transition: border-color 0.15s;
  }

  .reply-card:hover {
    border-color: var(--border-bright);
  }

  .reply-title {
    font-size: 14px;
    color: var(--text-0);
    display: block;
    margin-bottom: 2px;
  }

  .reply-meta {
    font-size: 12px;
    color: var(--text-2);
  }

  .comments-section {
    border-top: 1px solid var(--border);
    padding-top: 20px;
  }
</style>
