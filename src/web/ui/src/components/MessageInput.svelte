<script lang="ts">
import { reportTyping } from "../lib/client";

let {
  sending,
  onSend,
  mindName = "",
  conversationId = null,
  username = "",
}: {
  sending: boolean;
  onSend: (message: string, images: Array<{ media_type: string; data: string }>) => void;
  mindName?: string;
  conversationId?: string | null;
  username?: string;
} = $props();

let input = $state("");
let pendingImages = $state<Array<{ media_type: string; data: string; preview: string }>>([]);
let inputEl: HTMLTextAreaElement;
let fileEl: HTMLInputElement;
let typingTimer = 0;

function handleSend() {
  const message = input.trim();
  if (!message && pendingImages.length === 0) return;
  if (sending) return;

  const images = pendingImages.map(({ media_type, data }) => ({ media_type, data }));
  input = "";
  pendingImages = [];
  if (inputEl) {
    inputEl.style.height = "auto";
    inputEl.style.overflow = "hidden";
  }
  if (conversationId && mindName && username) {
    reportTyping(mindName, `volute:${conversationId}`, username, false);
    typingTimer = 0;
  }
  onSend(message, images);
}

function handleKeyDown(e: KeyboardEvent) {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    handleSend();
  }
}

function handleInput(e: Event) {
  const el = e.currentTarget as HTMLTextAreaElement;
  if (conversationId && mindName && username) {
    const now = Date.now();
    if (now - typingTimer > 3000) {
      typingTimer = now;
      reportTyping(mindName, `volute:${conversationId}`, username, true);
    }
  }
  el.style.height = "auto";
  const maxH = 120;
  el.style.height = `${Math.min(el.scrollHeight, maxH)}px`;
  el.style.overflow = el.scrollHeight > maxH ? "auto" : "hidden";
}

function handleBlur() {
  if (conversationId && mindName && username && typingTimer > 0) {
    reportTyping(mindName, `volute:${conversationId}`, username, false);
    typingTimer = 0;
  }
}

function handleFiles(files: FileList | null) {
  if (!files) return;
  for (const file of Array.from(files)) {
    if (!file.type.startsWith("image/")) continue;
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const base64 = result.split(",")[1];
      pendingImages = [...pendingImages, { media_type: file.type, data: base64, preview: result }];
    };
    reader.readAsDataURL(file);
  }
}

// Clear typing on unmount
$effect(() => {
  return () => {
    if (conversationId && mindName && username && typingTimer > 0) {
      reportTyping(mindName, `volute:${conversationId}`, username, false);
    }
  };
});
</script>

<!-- Image preview strip -->
{#if pendingImages.length > 0}
  <div class="image-strip">
    {#each pendingImages as img, i (img.preview)}
      <div class="image-preview">
        <img src={img.preview} alt="" class="preview-thumb" />
        <button class="remove-image" onclick={() => { pendingImages = pendingImages.filter((_, j) => j !== i); }}>x</button>
      </div>
    {/each}
  </div>
{/if}

<!-- Hidden file input -->
<input
  bind:this={fileEl}
  type="file"
  accept="image/*"
  multiple
  style="display: none"
  onchange={(e) => handleFiles((e.currentTarget as HTMLInputElement).files)}
/>

<!-- Input area -->
<div class="input-area">
  <button class="attach-btn" onclick={() => fileEl?.click()}>+</button>
  <textarea
    bind:this={inputEl}
    bind:value={input}
    onkeydown={handleKeyDown}
    oninput={handleInput}
    onblur={handleBlur}
    placeholder="Send a message..."
    rows={1}
    class="chat-input"
  ></textarea>
  <button
    onclick={handleSend}
    disabled={sending || (!input.trim() && pendingImages.length === 0)}
    class="send-btn"
    class:active={!!input.trim() || pendingImages.length > 0}
  >
    {sending ? "sending..." : "send"}
  </button>
</div>

<style>
  .image-strip {
    display: flex;
    gap: 8px;
    padding: 8px 0;
    border-top: 1px solid var(--border);
    overflow-x: auto;
  }

  .image-preview {
    position: relative;
    flex-shrink: 0;
  }

  .preview-thumb {
    height: 60px;
    border-radius: var(--radius);
    border: 1px solid var(--border);
  }

  .remove-image {
    position: absolute;
    top: -4px;
    right: -4px;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: var(--bg-3);
    color: var(--text-1);
    font-size: 11px;
    display: flex;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--border);
    cursor: pointer;
    padding: 0;
  }

  .input-area {
    border-top: 1px solid var(--border);
    padding: 12px 0 0;
    display: flex;
    gap: 8px;
  }

  .attach-btn {
    padding: 0 10px;
    background: var(--bg-2);
    color: var(--text-1);
    border-radius: var(--radius);
    font-size: 16px;
    border: 1px solid var(--border);
    cursor: pointer;
    flex-shrink: 0;
  }

  .chat-input {
    flex: 1;
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 10px 12px;
    color: var(--text-0);
    font-family: var(--mono);
    font-size: 13px;
    resize: none;
    outline: none;
    overflow: hidden;
    transition: border-color 0.15s;
  }

  .chat-input:focus {
    border-color: var(--border-bright);
  }

  .send-btn {
    padding: 0 16px;
    background: var(--bg-3);
    color: var(--text-2);
    border-radius: var(--radius);
    font-size: 12px;
    font-weight: 500;
    transition: all 0.15s;
  }

  .send-btn.active {
    background: var(--accent-dim);
    color: var(--accent);
  }
</style>
