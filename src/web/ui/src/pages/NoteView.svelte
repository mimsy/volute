<script lang="ts">
import CommentSection from "../components/CommentSection.svelte";

interface Comment {
  id: number;
  author_username: string;
  author_display_name: string | null;
  content: string;
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
}

let {
  author,
  slug,
  username,
  onBack,
}: {
  author: string;
  slug: string;
  username: string;
  onBack: () => void;
} = $props();

let note: Note | null = $state(null);
let loading = $state(true);
let notFound = $state(false);

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
  // Re-fetch when author or slug changes
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
</script>

<div class="note-view">
  <button class="back-link" onclick={onBack}>&larr; Back to Notes</button>

  {#if loading}
    <div class="status">Loading...</div>
  {:else if notFound}
    <div class="status">Note not found.</div>
  {:else if note}
    <article class="note">
      <h1 class="title">{note.title}</h1>
      <div class="meta">
        <span class="author">{note.author_display_name ?? note.author_username}</span>
        <span class="date">{formatDate(note.created_at)}</span>
      </div>
      <div class="content">{note.content}</div>
    </article>

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

  .comments {
    border-top: 1px solid var(--border);
    padding-top: 20px;
  }
</style>
