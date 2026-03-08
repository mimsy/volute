<script lang="ts">
import { onMount } from "svelte";
import NoteCard from "../components/NoteCard.svelte";

let { onSelectNote }: { onSelectNote: (author: string, slug: string) => void } = $props();

interface Note {
  title: string;
  author: string;
  slug: string;
  excerpt: string;
  commentCount: number;
  createdAt: string;
}

interface ApiNote {
  title: string;
  author_username: string;
  slug: string;
  content: string;
  comment_count: number;
  created_at: string;
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
  };
}

async function loadNotes() {
  try {
    const res = await fetch("/api/notes");
    if (!res.ok) throw new Error("Failed to load notes");
    const raw: ApiNote[] = await res.json();
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
    const res = await fetch("/api/notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: title.trim(), content: content.trim() }),
    });
    if (!res.ok) throw new Error("Failed to create note");
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
    <button class="btn btn-write" onclick={() => { showForm = !showForm; }}>
      {showForm ? "Cancel" : "Write a Note"}
    </button>
  </div>

  {#if showForm}
    <form class="note-form" onsubmit={submitNote}>
      <input
        type="text"
        class="form-input"
        placeholder="Title"
        bind:value={title}
      />
      <textarea
        class="form-textarea"
        placeholder="Write your note..."
        rows="6"
        bind:value={content}
      ></textarea>
      <div class="form-actions">
        <button
          type="submit"
          class="btn btn-submit"
          disabled={submitting || !title.trim() || !content.trim()}
        >
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
      {#each notes as note (note.slug)}
        <NoteCard
          title={note.title}
          author={note.author}
          slug={note.slug}
          excerpt={note.excerpt}
          commentCount={note.commentCount}
          createdAt={note.createdAt}
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
    animation: fadeIn 0.2s ease both;
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
    font-family: var(--sans);
    font-size: 14px;
    outline: none;
    box-sizing: border-box;
  }

  .form-input:focus {
    border-color: var(--accent);
  }

  .form-textarea {
    width: 100%;
    padding: 8px 12px;
    background: var(--bg-3);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--text-0);
    font-family: var(--sans);
    font-size: 14px;
    line-height: 1.5;
    resize: vertical;
    outline: none;
    box-sizing: border-box;
  }

  .form-textarea:focus {
    border-color: var(--accent);
  }

  .form-actions {
    display: flex;
    justify-content: flex-end;
  }

  .btn {
    font-family: var(--sans);
    font-size: 13px;
    padding: 6px 14px;
    border-radius: var(--radius);
    cursor: pointer;
    border: 1px solid transparent;
    transition: opacity 0.15s;
  }

  .btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .btn-write {
    background: var(--accent-dim);
    color: var(--accent);
    border-color: var(--accent-border);
  }

  .btn-write:hover {
    border-color: var(--accent);
  }

  .btn-submit {
    background: var(--accent-dim);
    color: var(--accent);
    border-color: var(--accent-border);
  }

  .btn-submit:hover:not(:disabled) {
    border-color: var(--accent);
  }

  .error {
    color: var(--red);
    font-size: 13px;
    margin-bottom: 16px;
  }

  .loading {
    color: var(--text-2);
    font-size: 13px;
    padding: 40px 0;
    text-align: center;
  }

  .empty {
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
