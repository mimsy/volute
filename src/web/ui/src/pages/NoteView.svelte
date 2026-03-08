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
  onBack,
  onNavigate,
}: {
  author: string;
  slug: string;
  username: string;
  onBack: () => void;
  onNavigate: (author: string, slug: string) => void;
} = $props();

let note: Note | null = $state(null);
let loading = $state(true);
let notFound = $state(false);
let emojiInput = $state("");
let showEmojiInput = $state(false);

async function fetchNote() {
  loading = true;
  notFound = false;
  note = null;
  try {
    const res = await fetch(`/api/notes/${encodeURIComponent(author)}/${encodeURIComponent(slug)}`);
    if (res.status === 404) {
      notFound = true;
    } else if (res.ok) {
      note = await res.json();
    } else {
      notFound = true;
    }
  } catch {
    notFound = true;
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
  await fetch(`/api/notes/${encodeURIComponent(author)}/${encodeURIComponent(slug)}/comments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  await fetchNote();
}

async function handleDeleteComment(commentId: number) {
  await fetch(
    `/api/notes/${encodeURIComponent(author)}/${encodeURIComponent(slug)}/comments/${commentId}`,
    {
      method: "DELETE",
    },
  );
  await fetchNote();
}

async function toggleReaction(emoji: string) {
  await fetch(`/api/notes/${encodeURIComponent(author)}/${encodeURIComponent(slug)}/reactions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ emoji }),
  });
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
  <button class="back-link" onclick={onBack}>&larr; Back to Notes</button>

  {#if loading}
    <div class="status">Loading...</div>
  {:else if notFound}
    <div class="status">Note not found.</div>
  {:else if note}
    <article class="note">
      {#if note.reply_to}
        <button class="reply-to-link" onclick={() => onNavigate(note!.reply_to!.author_username, note!.reply_to!.slug)}>
          ↩ In reply to: {note.reply_to.author_username}/{note.reply_to.slug} — {note.reply_to.title}
        </button>
      {/if}
      <h1 class="title">{note.title}</h1>
      <div class="meta">
        <span class="author">{note.author_display_name ?? note.author_username}</span>
        <span class="date">{formatDate(note.created_at)}</span>
      </div>
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
        <h3 class="section-title">Replies ({note.replies.length})</h3>
        {#each note.replies as reply}
          <button class="reply-link" onclick={() => onNavigate(reply.author_username, reply.slug)}>
            <span class="reply-title">{reply.title}</span>
            <span class="reply-meta">{reply.author_username} · {formatDate(reply.created_at)}</span>
          </button>
        {/each}
      </div>
    {/if}

    <div class="comments">
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
    max-width: 700px;
    margin: 0 auto;
    padding: 24px 16px;
    animation: fadeIn 0.2s ease both;
  }

  .back-link {
    background: none;
    border: none;
    font-family: var(--sans);
    font-size: 13px;
    color: var(--accent);
    cursor: pointer;
    padding: 0;
    margin-bottom: 24px;
    display: inline-block;
    transition: opacity 0.15s;
  }

  .back-link:hover {
    opacity: 0.8;
  }

  .status {
    color: var(--text-2);
    font-family: var(--sans);
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
    font-family: var(--sans);
    font-size: 13px;
    color: var(--text-2);
    cursor: pointer;
    padding: 0;
    margin-bottom: 12px;
    display: block;
    transition: color 0.15s;
    text-align: left;
  }

  .reply-to-link:hover {
    color: var(--accent);
  }

  .title {
    font-family: var(--display);
    font-size: 28px;
    font-weight: 600;
    color: var(--text-0);
    margin: 0 0 8px 0;
    line-height: 1.3;
  }

  .meta {
    display: flex;
    align-items: baseline;
    gap: 8px;
    margin-bottom: 20px;
  }

  .author {
    font-family: var(--sans);
    font-size: 14px;
    color: var(--accent);
    font-weight: 500;
  }

  .date {
    font-family: var(--sans);
    font-size: 13px;
    color: var(--text-2);
  }

  .content {
    font-family: var(--sans);
    font-size: 15px;
    color: var(--text-0);
    line-height: 1.6;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .reactions-bar {
    display: flex;
    gap: 6px;
    margin-top: 16px;
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
    font-family: var(--sans);
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
    font-family: var(--sans);
    font-size: 13px;
    outline: none;
  }

  .emoji-input:focus {
    border-color: var(--accent);
  }

  .replies-section {
    border-top: 1px solid var(--border);
    padding-top: 16px;
    margin-bottom: 24px;
  }

  .section-title {
    font-family: var(--sans);
    font-size: 14px;
    font-weight: 500;
    color: var(--text-1);
    margin: 0 0 10px;
  }

  .reply-link {
    display: block;
    width: 100%;
    text-align: left;
    background: none;
    border: none;
    padding: 8px 0;
    cursor: pointer;
    font-family: var(--sans);
    transition: opacity 0.15s;
  }

  .reply-link:hover {
    opacity: 0.8;
  }

  .reply-title {
    font-size: 14px;
    color: var(--accent);
    display: block;
  }

  .reply-meta {
    font-size: 12px;
    color: var(--text-2);
  }

  .comments {
    border-top: 1px solid var(--border);
    padding-top: 20px;
  }
</style>
