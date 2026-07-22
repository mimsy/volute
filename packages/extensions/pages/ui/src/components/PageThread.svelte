<script lang="ts">
import { renderMarkdown } from "@volute/ui/markdown";
import {
  deleteComment as apiDeleteComment,
  fetchThread,
  type PageThread,
  postComment,
  toggleReaction,
} from "../lib/api";

let {
  mind,
  file,
  currentUsername,
  userAvatarUrl = null,
}: {
  mind: string;
  file: string;
  currentUsername: string;
  userAvatarUrl?: string | null;
} = $props();

const QUICK_REACTIONS = ["🌱", "✨", "👀", "💭"];

let thread = $state<PageThread | null>(null);
let draft = $state("");
let busy = $state(false);

$effect(() => {
  // Re-load whenever the page being viewed changes.
  const key = `${mind}/${file}`;
  void key;
  let cancelled = false;
  fetchThread(mind, file).then((t) => {
    if (!cancelled) thread = t;
  });
  return () => {
    cancelled = true;
  };
});

async function reload() {
  thread = await fetchThread(mind, file);
}

async function submit() {
  const text = draft.trim();
  if (!text || busy) return;
  busy = true;
  draft = "";
  const created = await postComment(mind, file, text);
  if (!created) draft = text; // put it back rather than swallowing the write
  await reload();
  busy = false;
}

function handleKeyDown(e: KeyboardEvent) {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    void submit();
  }
}

async function react(emoji: string) {
  if (busy) return;
  busy = true;
  await toggleReaction(mind, file, emoji);
  await reload();
  busy = false;
}

async function remove(id: number) {
  if (await apiDeleteComment(id)) await reload();
}

// The API serializes thread timestamps as ISO-8601 UTC, so no zone repair here.
function formatDate(iso: string): string {
  const d = new Date(iso);
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
}

function initial(name: string): string {
  return (name[0] ?? "?").toUpperCase();
}

let mine = $derived(currentUsername);
</script>

{#if thread}
  <section class="thread">
    {#if thread.deleted_at}
      <div class="tombstone">
        [this page was deleted] — its conversation is kept here.
      </div>
    {/if}

    <div class="reactions">
      {#each thread.reactions as r (r.emoji)}
        <button
          class="reaction"
          class:mine={r.usernames.includes(mine)}
          title={r.usernames.join(", ")}
          onclick={() => react(r.emoji)}
        >
          <span>{r.emoji}</span><span class="count">{r.count}</span>
        </button>
      {/each}
      {#each QUICK_REACTIONS.filter((e) => !thread?.reactions.some((r) => r.emoji === e)) as emoji (emoji)}
        <button class="reaction add" onclick={() => react(emoji)}>{emoji}</button>
      {/each}
    </div>

    <h3 class="header">
      {thread.comments.length}
      {thread.comments.length === 1 ? "comment" : "comments"}
    </h3>

    {#each thread.comments as comment (comment.id)}
      <div class="comment">
        <div class="comment-header">
          <span class="author">{comment.author_display_name ?? comment.author_username}</span>
          <span class="date">{formatDate(comment.created_at)}</span>
          {#if comment.stale}
            <span class="stale" title="The page has changed since this was written">
              on an earlier version
            </span>
          {/if}
          {#if comment.author_username === mine || mind === mine}
            <button class="delete" onclick={() => remove(comment.id)}>delete</button>
          {/if}
        </div>
        <div class="body markdown-body">{@html renderMarkdown(comment.content)}</div>
      </div>
    {/each}

    <div class="compose">
      <div class="avatar">
        {#if userAvatarUrl}
          <img src={userAvatarUrl} alt="" loading="lazy" decoding="async" />
        {:else}
          <div class="avatar-fallback">{initial(mine)}</div>
        {/if}
      </div>
      <div class="compose-box">
        <textarea
          bind:value={draft}
          onkeydown={handleKeyDown}
          placeholder="Say something about this page..."
          rows={2}
        ></textarea>
        <div class="compose-footer">
          <button class="submit" class:active={!!draft.trim()} disabled={!draft.trim() || busy} onclick={submit}>
            Comment
          </button>
        </div>
      </div>
    </div>
  </section>
{/if}

<style>
  .thread {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 16px 24px 24px;
    border-top: 1px solid var(--border);
    background: var(--bg-1);
    overflow-y: auto;
  }

  .tombstone {
    font-size: 13px;
    color: var(--text-2);
    font-style: italic;
  }

  .header {
    font-family: var(--sans);
    font-size: 14px;
    font-weight: 500;
    color: var(--text-1);
    margin: 0;
  }

  .reactions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .reaction {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 3px 8px;
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: 999px;
    font-size: 13px;
    color: var(--text-1);
    cursor: pointer;
    transition: all 0.15s;
  }

  .reaction:hover {
    border-color: var(--border-bright);
  }

  .reaction.mine {
    background: var(--accent-dim);
    border-color: var(--accent);
  }

  .reaction.add {
    opacity: 0.45;
  }

  .reaction.add:hover {
    opacity: 1;
  }

  .count {
    font-size: 12px;
    color: var(--text-2);
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

  .date,
  .stale {
    font-size: 12px;
    color: var(--text-2);
  }

  .stale {
    font-style: italic;
  }

  .delete {
    margin-left: auto;
    background: none;
    border: none;
    font-size: 12px;
    color: var(--text-2);
    cursor: pointer;
    padding: 0;
  }

  .delete:hover {
    color: #e55;
  }

  .body {
    font-size: 14px;
    color: var(--text-0);
    word-break: break-word;
  }

  .compose {
    display: flex;
    gap: 10px;
    align-items: flex-start;
  }

  .avatar {
    flex-shrink: 0;
    width: 32px;
    height: 32px;
    margin-top: 2px;
  }

  .avatar img,
  .avatar-fallback {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    object-fit: cover;
  }

  .avatar-fallback {
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

  textarea {
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
    box-sizing: border-box;
    transition: border-color 0.15s;
  }

  textarea:focus {
    border-color: var(--border-bright);
  }

  .compose-footer {
    display: flex;
    justify-content: flex-end;
  }

  .submit {
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

  .submit.active {
    background: var(--accent-dim);
    color: var(--accent);
  }

  .submit:disabled {
    cursor: default;
    opacity: 0.5;
  }
</style>
