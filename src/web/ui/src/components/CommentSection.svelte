<script lang="ts">
interface Comment {
  id: number;
  author_username: string;
  author_display_name: string | null;
  content: string;
  created_at: string;
}

let {
  comments,
  onComment,
  onDelete,
  currentUsername,
}: {
  comments: Comment[];
  onComment: (content: string) => void;
  onDelete?: (commentId: number) => void;
  currentUsername: string;
} = $props();

let draft = $state("");

function handleSubmit() {
  const text = draft.trim();
  if (!text) return;
  draft = "";
  onComment(text);
}

function handleKeyDown(e: KeyboardEvent) {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    handleSubmit();
  }
}

function formatDate(iso: string): string {
  const d = new Date(`${iso.replace(" ", "T")}Z`);
  return (
    d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
    " " +
    d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
  );
}
</script>

<section class="comment-section">
  <h3 class="section-header">Comments ({comments.length})</h3>

  {#if comments.length > 0}
    <div class="comment-list">
      {#each comments as comment (comment.id)}
        <div class="comment">
          <div class="comment-header">
            <span class="author">{comment.author_display_name ?? comment.author_username}</span>
            <span class="date">{formatDate(comment.created_at)}</span>
            {#if onDelete && comment.author_username === currentUsername}
              <button class="delete-btn" onclick={() => onDelete?.(comment.id)}>delete</button>
            {/if}
          </div>
          <div class="comment-body">{comment.content}</div>
        </div>
      {/each}
    </div>
  {/if}

  <div class="compose">
    <textarea
      bind:value={draft}
      onkeydown={handleKeyDown}
      placeholder="Write a comment..."
      rows={2}
      class="compose-input"
    ></textarea>
    <button
      class="submit-btn"
      class:active={!!draft.trim()}
      disabled={!draft.trim()}
      onclick={handleSubmit}
    >comment</button>
  </div>
</section>

<style>
  .comment-section {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .section-header {
    font-family: var(--sans);
    font-size: 14px;
    font-weight: 500;
    color: var(--text-1);
    margin: 0;
  }

  .comment-list {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .comment {
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 10px 12px;
  }

  .comment-header {
    display: flex;
    align-items: baseline;
    gap: 8px;
    margin-bottom: 4px;
  }

  .author {
    font-family: var(--sans);
    font-size: 13px;
    font-weight: 500;
    color: var(--accent);
  }

  .date {
    font-family: var(--sans);
    font-size: 12px;
    color: var(--text-2);
  }

  .delete-btn {
    margin-left: auto;
    background: none;
    border: none;
    font-family: var(--sans);
    font-size: 12px;
    color: var(--text-2);
    cursor: pointer;
    padding: 0;
    transition: color 0.15s;
  }

  .delete-btn:hover {
    color: #e55;
  }

  .comment-body {
    font-family: var(--sans);
    font-size: 14px;
    color: var(--text-0);
    white-space: pre-wrap;
    word-break: break-word;
  }

  .compose {
    display: flex;
    gap: 8px;
  }

  .compose-input {
    flex: 1;
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 8px 12px;
    color: var(--text-0);
    font-family: var(--sans);
    font-size: 14px;
    resize: none;
    outline: none;
    transition: border-color 0.15s;
  }

  .compose-input:focus {
    border-color: var(--border-bright);
  }

  .submit-btn {
    padding: 0 14px;
    background: var(--bg-3);
    color: var(--text-2);
    border: none;
    border-radius: var(--radius);
    font-family: var(--sans);
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s;
    align-self: flex-end;
  }

  .submit-btn.active {
    background: var(--accent-dim);
    color: var(--accent);
  }

  .submit-btn:disabled {
    cursor: default;
  }
</style>
