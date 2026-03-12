<script lang="ts">
import { onMount } from "svelte";
import NoteCard from "../components/NoteCard.svelte";
import { type ApiNote, createNote, fetchNotes } from "../lib/api";

let {
  author,
  onSelectNote,
}: { author?: string; onSelectNote: (author: string, slug: string) => void } = $props();

interface Note {
  title: string;
  author: string;
  slug: string;
  excerpt: string;
  commentCount: number;
  createdAt: string;
  replyTo?: { author_username: string; slug: string; title: string } | null;
  reactions?: { emoji: string; count: number }[];
}

let notes = $state<Note[]>([]);
let loading = $state(true);
let error = $state("");
let showForm = $state(false);
let title = $state("");
let content = $state("");
let submitting = $state(false);

function mapNote(n: ApiNote): Note {
  const excerpt = n.content.length > 200 ? `${n.content.slice(0, 200)}...` : n.content;
  return {
    title: n.title,
    author: n.author_username,
    slug: n.slug,
    excerpt,
    commentCount: n.comment_count,
    createdAt: n.created_at,
    replyTo: n.reply_to,
    reactions: n.reactions,
  };
}

async function loadNotes() {
  try {
    const raw = await fetchNotes({ author });
    notes = raw.map(mapNote);
    error = "";
  } catch (e) {
    error = e instanceof Error ? e.message : "Failed to load notes";
  } finally {
    loading = false;
  }
}

async function submitNote(e: Event) {
  e.preventDefault();
  if (!title.trim() || !content.trim() || submitting) return;
  submitting = true;
  try {
    await createNote(title.trim(), content.trim());
    title = "";
    content = "";
    showForm = false;
    await loadNotes();
  } catch (e) {
    error = e instanceof Error ? e.message : "Failed to create note";
  } finally {
    submitting = false;
  }
}

onMount(() => {
  loadNotes();
});
</script>

<div class="notes-page">
  <div class="page-header">
    <h2 class="page-title">Notes</h2>
    {#if !author}
      <button class="btn btn-write" onclick={() => { showForm = !showForm; }}>
        {showForm ? "Cancel" : "Write a Note"}
      </button>
    {/if}
  </div>

  {#if showForm}
    <form class="note-form" onsubmit={submitNote}>
      <input type="text" class="form-input" placeholder="Title" bind:value={title} />
      <textarea class="form-textarea" placeholder="Write your note..." rows="6" bind:value={content}></textarea>
      <div class="form-actions">
        <button type="submit" class="btn btn-submit" disabled={submitting || !title.trim() || !content.trim()}>
          {submitting ? "Publishing..." : "Publish"}
        </button>
      </div>
    </form>
  {/if}

  {#if error}
    <div class="error">{error}</div>
  {/if}

  {#if loading}
    <div class="loading">Loading notes...</div>
  {:else if notes.length === 0}
    <div class="empty">No notes yet. Be the first to write one.</div>
  {:else}
    <div class="notes-list">
      {#each notes as note (`${note.author}/${note.slug}`)}
        <NoteCard
          title={note.title}
          author={note.author}
          slug={note.slug}
          excerpt={note.excerpt}
          commentCount={note.commentCount}
          createdAt={note.createdAt}
          replyTo={note.replyTo}
          reactions={note.reactions}
          onSelect={onSelectNote}
        />
      {/each}
    </div>
  {/if}
</div>

<style>
  .notes-page {
    max-width: 700px;
    margin: 0 auto;
  }

  .page-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 24px;
  }

  .page-title {
    font-family: var(--display);
    font-size: 22px;
    font-weight: 400;
    color: var(--text-0);
    margin: 0;
  }

  .note-form {
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: 16px;
    margin-bottom: 20px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .form-input {
    width: 100%;
    padding: 8px 12px;
    background: var(--bg-3);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--text-0);
    font-size: 14px;
    outline: none;
    box-sizing: border-box;
  }

  .form-input:focus { border-color: var(--accent); }

  .form-textarea {
    width: 100%;
    padding: 8px 12px;
    background: var(--bg-3);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--text-0);
    font-size: 14px;
    line-height: 1.5;
    resize: vertical;
    outline: none;
    box-sizing: border-box;
  }

  .form-textarea:focus { border-color: var(--accent); }

  .form-actions {
    display: flex;
    justify-content: flex-end;
  }

  .btn {
    font-size: 13px;
    padding: 6px 14px;
    border-radius: var(--radius);
    cursor: pointer;
    border: 1px solid transparent;
    transition: opacity 0.15s;
  }

  .btn:disabled { opacity: 0.5; cursor: not-allowed; }

  .btn-write {
    background: var(--accent-dim);
    color: var(--accent);
    border-color: var(--accent-border);
  }

  .btn-write:hover { border-color: var(--accent); }

  .btn-submit {
    background: var(--accent-dim);
    color: var(--accent);
    border-color: var(--accent-border);
  }

  .btn-submit:hover:not(:disabled) { border-color: var(--accent); }

  .error {
    color: var(--red);
    font-size: 13px;
    margin-bottom: 16px;
  }

  .loading, .empty {
    color: var(--text-2);
    font-size: 13px;
    padding: 40px 0;
    text-align: center;
  }

  .notes-list {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
</style>
