<script lang="ts">
import CommentSection from "../components/CommentSection.svelte";
import { type ApiNote, addComment, deleteComment, fetchNote, toggleReaction } from "../lib/api";

let {
  author,
  slug,
  username,
  onNavigate,
  onBack,
}: {
  author: string;
  slug: string;
  username: string;
  onNavigate: (author: string, slug: string) => void;
  onBack: () => void;
} = $props();

let note: ApiNote | null = $state(null);
let loading = $state(true);
let notFound = $state(false);
let error = $state("");
let emojiInput = $state("");
let showEmojiInput = $state(false);

async function load() {
  loading = true;
  notFound = false;
  error = "";
  note = null;
  try {
    const result = await fetchNote(author, slug);
    if (!result) {
      notFound = true;
    } else {
      note = result;
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
  load();
});

async function handleComment(content: string) {
  try {
    await addComment(author, slug, content);
  } catch {
    error = "Failed to add comment";
    return;
  }
  await load();
}

async function handleDeleteComment(commentId: number) {
  try {
    await deleteComment(author, slug, commentId);
  } catch {
    error = "Failed to delete comment";
    return;
  }
  await load();
}

async function handleToggleReaction(emoji: string) {
  try {
    await toggleReaction(author, slug, emoji);
  } catch {
    return;
  }
  await load();
}

async function submitEmoji(e: Event) {
  e.preventDefault();
  const emoji = emojiInput.trim();
  if (!emoji) return;
  emojiInput = "";
  showEmojiInput = false;
  await handleToggleReaction(emoji);
}

function formatDate(iso: string): string {
  return new Date(`${iso.replace(" ", "T")}Z`).toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function hasReacted(reaction: { usernames: string[] }): boolean {
  return reaction.usernames.includes(username);
}
</script>

<div class="note-view">
  <button class="back-btn" onclick={onBack}>&larr; Back</button>

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
              onclick={() => handleToggleReaction(reaction.emoji)}
            >
              {reaction.emoji} {reaction.count}
            </button>
          {/each}
        {/if}
        {#if showEmojiInput}
          <form class="emoji-form" onsubmit={submitEmoji}>
            <input class="emoji-input" bind:value={emojiInput} placeholder="emoji" maxlength="32" />
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
        comments={note.comments ?? []}
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
  }

  .back-btn {
    background: none;
    border: none;
    color: var(--text-2);
    font-size: 13px;
    cursor: pointer;
    padding: 0;
    margin-bottom: 16px;
  }

  .back-btn:hover { color: var(--text-1); }

  .error {
    font-size: 13px;
    color: var(--red);
    margin-bottom: 12px;
  }

  .status {
    color: var(--text-2);
    font-size: 14px;
    padding: 32px 0;
    text-align: center;
  }

  .note { margin-bottom: 32px; }

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

  .reply-to-link:hover { color: var(--accent); }
  .reply-arrow { opacity: 0.6; }
  .reply-ref { color: var(--text-1); font-style: italic; }
  .reply-to-link:hover .reply-ref { color: var(--accent); }

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
  }

  .author { font-size: 14px; color: var(--text-1); font-weight: 500; }
  .sep { color: var(--text-2); font-size: 12px; }
  .date { font-size: 13px; color: var(--text-2); }
  .divider { height: 1px; background: var(--border); margin: 16px 0 20px; }

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

  .reaction-pill:hover { border-color: var(--border-bright); }
  .reaction-pill.active { border-color: var(--accent-border); background: var(--accent-dim); }
  .add-reaction { color: var(--text-2); font-size: 14px; }
  .emoji-form { display: inline-flex; }

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

  .emoji-input:focus { border-color: var(--accent); }

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

  .reply-card:hover { border-color: var(--border-bright); }
  .reply-title { font-size: 14px; color: var(--text-0); display: block; margin-bottom: 2px; }
  .reply-meta { font-size: 12px; color: var(--text-2); }

  .comments-section {
    border-top: 1px solid var(--border);
    padding-top: 20px;
  }
</style>
