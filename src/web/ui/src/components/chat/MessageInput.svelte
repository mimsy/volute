<script lang="ts">
import { reportTyping } from "../../lib/client";
import Dropdown from "../ui/Dropdown.svelte";

let {
  sending,
  onSend,
  mindName = "",
  conversationId = null,
  username = "",
}: {
  sending: boolean;
  onSend: (
    message: string,
    images: Array<{ media_type: string; data: string }>,
    files: Array<{ filename: string; data: string }>,
  ) => void;
  mindName?: string;
  conversationId?: string | null;
  username?: string;
} = $props();

let input = $state("");
let pendingImages = $state<Array<{ media_type: string; data: string; preview: string }>>([]);
let pendingFiles = $state<Array<{ filename: string; data: string }>>([]);
let inputEl: HTMLTextAreaElement;
let fileEl: HTMLInputElement;
let attachFileEl: HTMLInputElement;
let typingTimer = 0;
let inputFocused = $state(false);
let showAttach = $state(false);

function toggleAttachMenu() {
  showAttach = !showAttach;
}

function handleSend() {
  const message = input.trim();
  if (!message && pendingImages.length === 0 && pendingFiles.length === 0) return;
  if (sending) return;

  const images = pendingImages.map(({ media_type, data }) => ({ media_type, data }));
  const files = [...pendingFiles];
  input = "";
  pendingImages = [];
  pendingFiles = [];
  if (inputEl) {
    inputEl.style.height = "auto";
    inputEl.style.overflow = "hidden";
  }
  if (conversationId && mindName && username) {
    reportTyping(mindName, conversationId, username, false);
    typingTimer = 0;
  }
  onSend(message, images, files);
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
      reportTyping(mindName, conversationId, username, true);
    }
  }
  el.style.height = "auto";
  const maxH = 120;
  el.style.height = `${Math.min(el.scrollHeight, maxH)}px`;
  el.style.overflow = el.scrollHeight > maxH ? "auto" : "hidden";
}

function handleBlur() {
  if (conversationId && mindName && username && typingTimer > 0) {
    reportTyping(mindName, conversationId, username, false);
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

function handleAttachFiles(files: FileList | null) {
  if (!files) return;
  const MAX_FILE_SIZE = 50 * 1024 * 1024;
  for (const file of Array.from(files)) {
    if (file.size > MAX_FILE_SIZE) continue;
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as ArrayBuffer;
      const bytes = new Uint8Array(result);
      let binary = "";
      for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      const base64 = btoa(binary);
      pendingFiles = [...pendingFiles, { filename: file.name, data: base64 }];
    };
    reader.readAsArrayBuffer(file);
  }
}

// Clear typing on unmount
$effect(() => {
  return () => {
    if (conversationId && mindName && username && typingTimer > 0) {
      reportTyping(mindName, conversationId, username, false);
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

<!-- File preview strip -->
{#if pendingFiles.length > 0}
  <div class="file-strip">
    {#each pendingFiles as file, i (file.filename + i)}
      <div class="file-preview">
        <span class="file-name">{file.filename}</span>
        <button class="remove-image" onclick={() => { pendingFiles = pendingFiles.filter((_, j) => j !== i); }}>x</button>
      </div>
    {/each}
  </div>
{/if}

<!-- Hidden file inputs -->
<input
  bind:this={fileEl}
  type="file"
  accept="image/*"
  multiple
  style="display: none"
  onchange={(e) => handleFiles((e.currentTarget as HTMLInputElement).files)}
/>
<input
  bind:this={attachFileEl}
  type="file"
  multiple
  style="display: none"
  onchange={(e) => handleAttachFiles((e.currentTarget as HTMLInputElement).files)}
/>

<!-- Input area -->
<div class="input-area">
  <div class="input-box" class:focused={inputFocused}>
    <button class="inline-btn attach" title="Attach image or file" onclick={toggleAttachMenu}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
    </button>
    <Dropdown open={showAttach} onclose={() => (showAttach = false)} direction="up">
      <button onclick={() => { showAttach = false; fileEl?.click(); }}>Image</button>
      <button onclick={() => { showAttach = false; attachFileEl?.click(); }}>File</button>
    </Dropdown>
    <textarea
      bind:this={inputEl}
      bind:value={input}
      onkeydown={handleKeyDown}
      oninput={handleInput}
      onfocus={() => inputFocused = true}
      onblur={() => { inputFocused = false; handleBlur(); }}
      placeholder="Send a message..."
      rows={1}
      class="chat-input"
    ></textarea>
    <button
      onclick={handleSend}
      disabled={sending || (!input.trim() && pendingImages.length === 0 && pendingFiles.length === 0)}
      class="inline-btn send"
      class:active={!!input.trim() || pendingImages.length > 0 || pendingFiles.length > 0}
    >
      {#if sending}
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
      {:else}
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
      {/if}
    </button>
  </div>
</div>

<style>
  .image-strip {
    display: flex;
    gap: 8px;
    padding: 4px 16px;
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
    font-size: 12px;
    display: flex;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--border);
    cursor: pointer;
    padding: 0;
  }

  .file-strip {
    display: flex;
    gap: 8px;
    padding: 4px 16px;
    overflow-x: auto;
    flex-wrap: wrap;
  }

  .file-preview {
    display: flex;
    align-items: center;
    gap: 4px;
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 4px 8px;
    font-size: 12px;
    color: var(--text-1);
  }

  .file-name {
    max-width: 150px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .input-area {
    padding: 8px 16px 16px;
    display: flex;
  }

  .input-box {
    flex: 1;
    display: flex;
    align-items: flex-end;
    gap: 4px;
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: 20px;
    padding: 4px 6px;
    transition: border-color 0.15s;
    position: relative;
  }

  .input-box.focused {
    border-color: var(--border-bright);
  }

  .chat-input {
    flex: 1;
    background: transparent;
    border: none;
    padding: 6px 4px;
    color: var(--text-0);
    font-family: var(--mono);
    font-size: 14px;
    resize: none;
    outline: none;
    overflow: hidden;
    line-height: 1.4;
  }

  .inline-btn {
    flex-shrink: 0;
    width: 32px;
    height: 32px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    border: none;
    background: transparent;
    color: var(--text-2);
    cursor: pointer;
    transition: all 0.15s;
    padding: 0;
  }

  .inline-btn:hover {
    background: var(--bg-3);
    color: var(--text-1);
  }

  .inline-btn.send.active {
    background: var(--accent-dim);
    color: var(--accent);
  }

  .inline-btn.send:disabled {
    opacity: 0.3;
    cursor: default;
  }

  .inline-btn.send:disabled:hover {
    background: transparent;
  }

  .input-box :global(.dropdown button) {
    background: transparent;
    border: none;
    color: var(--text-1);
    padding: 6px 14px;
    border-radius: var(--radius);
    font-size: 13px;
    cursor: pointer;
    text-align: left;
    white-space: nowrap;
  }

  .input-box :global(.dropdown button:hover) {
    background: var(--bg-3);
  }

  @media (max-width: 767px) {
    .chat-input {
      font-size: 16px;
    }

    .input-area {
      padding-bottom: max(16px, env(safe-area-inset-bottom));
    }
  }
</style>
