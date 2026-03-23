<script lang="ts">
import { renderMarkdown } from "@volute/ui/markdown";

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
  userAvatarUrl = null,
}: {
  comments: Comment[];
  onComment: (content: string) => void;
  onDelete?: (commentId: number) => void;
  currentUsername: string;
  userAvatarUrl?: string | null;
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

function initial(name: string): string {
  return (name[0] ?? "?").toUpperCase();
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
          <div class="comment-body markdown-body">{@html renderMarkdown(comment.content)}</div>
        </div>
      {/each}
    </div>
  {/if}

  <div class="compose">
    <div class="compose-avatar">
      {#if userAvatarUrl}
        <img src={userAvatarUrl} alt="" class="avatar-img" />
      {:else}
        <div class="avatar-fallback">{initial(currentUsername)}</div>
      {/if}
    </div>
    <div class="compose-box">
      <textarea
        bind:value={draft}
        onkeydown={handleKeyDown}
        placeholder="Write a comment..."
        rows={2}
        class="compose-input"
      ></textarea>
      <div class="compose-footer">
        <button
          class="submit-btn"
          class:active={!!draft.trim()}
          disabled={!draft.trim()}
          onclick={handleSubmit}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
          Comment
        </button>
      </div>
    </div>
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
    font-size: 13px;
    font-weight: 500;
    color: var(--accent);
  }

  .date {
    font-size: 12px;
    color: var(--text-2);
  }

  .delete-btn {
    margin-left: auto;
    background: none;
    border: none;
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
    font-size: 14px;
    color: var(--text-0);
    word-break: break-word;
  }

  .compose {
    display: flex;
    gap: 10px;
    align-items: flex-start;
  }

  .compose-avatar {
    flex-shrink: 0;
    width: 32px;
    height: 32px;
    margin-top: 2px;
  }

  .avatar-img {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    object-fit: cover;
  }

  .avatar-fallback {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    background: var(--bg-3);
    border: 1px solid var(--border);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 13px;
    font-weight: 600;
    color: var(--text-2);
  }

  .compose-box {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .compose-input {
    width: 100%;
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: 8px 12px;
    color: var(--text-0);
    font-family: var(--sans);
    font-size: 14px;
    resize: none;
    outline: none;
    transition: border-color 0.15s;
    box-sizing: border-box;
  }

  .compose-input:focus {
    border-color: var(--border-bright);
  }

  .compose-footer {
    display: flex;
    justify-content: flex-end;
  }

  .submit-btn {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 5px 12px;
    background: var(--bg-3);
    color: var(--text-2);
    border: none;
    border-radius: var(--radius);
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s;
  }

  .submit-btn.active {
    background: var(--accent-dim);
    color: var(--accent);
  }

  .submit-btn:disabled {
    cursor: default;
    opacity: 0.5;
  }
</style>
