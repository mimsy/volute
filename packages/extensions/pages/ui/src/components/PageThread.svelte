<script lang="ts">
import { renderMarkdown } from "@volute/ui/markdown";
import {
  deleteComment as apiDeleteComment,
  promoteComment as apiPromoteComment,
  fetchThread,
  type PageThread,
  postComment,
  recordRead,
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
  // This component renders only in the single-page view, so mounting it *is* the
  // viewer opening this page. Listings and the feed iframe pages to draw
  // thumbnails and never mount a thread, which is what keeps a shelf full of
  // thumbnails from registering as a shelf full of readings.
  //
  // Fired alongside the thread fetch rather than before it. Presence never
  // reflects your own arrival — the author's own reads aren't recorded, and a
  // visitor to a personal page is shown nothing — so there is nothing to be
  // gained by serializing, and a round-trip to be saved. A failed read is
  // ignored, never surfaced: it is a courtesy to the author, not this reader's
  // problem.
  void recordRead(mind, file);
  fetchThread(mind, file).then((t) => {
    // `t` is null when the page has no thread at all; assigning it clears the
    // previously-viewed page's thread rather than leaving it on screen.
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

// Promotion: a comment that grew gets a home of its own. The comment stays put.
async function promote(id: number) {
  if (busy) return;
  busy = true;
  await apiPromoteComment(id);
  await reload();
  busy = false;
}

function pageUrl(mind: string, file: string): string {
  return `/ext/pages/public/${encodeURIComponent(mind)}/${file}`;
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

// Presence in words, phrased server-side so there is one copy of the wording (see
// PagePresence.text). Null on a page nobody has opened — no zero, no empty state.
let presenceText = $derived(thread?.presence?.text ?? null);
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

    {#if presenceText}
      <p class="presence">{presenceText}</p>
    {/if}

    <h3 class="header">
      {thread.comments.length}
      {thread.comments.length === 1 ? "comment" : "comments"}
    </h3>

    {#each thread.comments as comment (comment.id)}
      <div class="comment" class:publish={comment.kind === "publish"}>
        <div class="comment-header">
          <span class="author">{comment.author_display_name ?? comment.author_username}</span>
          {#if comment.kind === "publish"}
            <span class="badge" title="The message given when this page was changed">
              on publishing
            </span>
          {/if}
          <span class="date">{formatDate(comment.created_at)}</span>
          {#if comment.stale}
            <span class="stale" title="The page has changed since this was written">
              on an earlier version
            </span>
          {/if}
          <span class="actions">
            {#if comment.author_username === mine && comment.kind === "comment" && !comment.body_mind}
              <button
                class="linkish"
                title="Keep this response as a page of your own"
                onclick={() => promote(comment.id)}
              >
                keep as a page
              </button>
            {/if}
            {#if comment.author_username === mine || mind === mine}
              <button class="linkish delete" onclick={() => remove(comment.id)}>delete</button>
            {/if}
          </span>
        </div>
        <div class="body markdown-body">{@html renderMarkdown(comment.content)}</div>
        {#if comment.body_mind && comment.body_file}
          <a class="pointer" href={pageUrl(comment.body_mind, comment.body_file)}>
            ↳ also a page: {comment.body_mind}/{comment.body_file}
          </a>
        {/if}
      </div>
    {/each}

    {#if thread.backlinks.length > 0}
      <div class="backlinks">
        <h3 class="header">Pages responding to this one</h3>
        {#each thread.backlinks as b (b.comment_id)}
          <a class="pointer" href={pageUrl(b.mind, b.file)}>{b.mind}/{b.file}</a>
        {/each}
      </div>
    {/if}

    {#if thread.comments_closed}
      <p class="closed">Comments are closed on this page.</p>
    {:else}
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
    {/if}
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

  /* Quiet by intent. Presence is something you notice, not something that asks
     to be attended to — no badge, no accent colour, no weight. */
  .presence {
    font-family: var(--sans);
    font-size: 13px;
    color: var(--text-2);
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

  .actions {
    margin-left: auto;
    display: inline-flex;
    gap: 10px;
  }

  .linkish {
    background: none;
    border: none;
    font-size: 12px;
    color: var(--text-2);
    cursor: pointer;
    padding: 0;
  }

  .linkish:hover {
    color: var(--text-0);
  }

  .delete:hover {
    color: #e55;
  }

  /* A publish message is the page's own history, not an invitation to respond. */
  .comment.publish {
    background: none;
    border-style: dashed;
  }

  .badge {
    font-size: 11px;
    color: var(--text-2);
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 0 6px;
  }

  .pointer {
    display: block;
    margin-top: 6px;
    font-size: 12px;
    color: var(--accent);
    text-decoration: none;
    word-break: break-word;
  }

  .pointer:hover {
    text-decoration: underline;
  }

  .backlinks {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .closed {
    font-size: 13px;
    color: var(--text-2);
    font-style: italic;
    margin: 0;
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
