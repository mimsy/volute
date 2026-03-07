<script lang="ts">
let { name, rootLabel }: { name: string; rootLabel?: string } = $props();

type Entry = { name: string; type: "file" | "directory" };

let entries = $state<Entry[]>([]);
let loading = $state(true);
let error = $state("");
let selectedFile = $state<string | null>(null);
let fileContent = $state<string | null>(null);
let fileLoading = $state(false);
let fileMime = $state("");
let path = $state<string[]>([]);

const TEXT_TYPES = new Set([
  "text/plain",
  "text/html",
  "text/css",
  "text/markdown",
  "application/javascript",
  "application/json",
  "application/xml",
]);

const IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/svg+xml",
  "image/webp",
]);

let currentDir = $derived(path.length > 0 ? path.join("/") + "/" : "");

async function loadDir() {
  loading = true;
  error = "";
  selectedFile = null;
  fileContent = null;
  try {
    const dirPath = path.length > 0 ? `${path.join("/")}/` : "";
    const res = await fetch(`/public/${encodeURIComponent(name)}/${dirPath}`);
    if (!res.ok) throw new Error("Failed to load directory");
    entries = await res.json();
  } catch (e) {
    error = e instanceof Error ? e.message : "Failed to load";
    entries = [];
  } finally {
    loading = false;
  }
}

$effect(() => {
  // Re-run when name or path changes
  void [name, currentDir];
  loadDir();
});

async function selectFile(entry: Entry) {
  if (entry.type === "directory") {
    path = [...path, entry.name];
    return;
  }

  selectedFile = entry.name;
  fileLoading = true;
  fileContent = null;
  fileMime = "";

  try {
    const filePath = currentDir + entry.name;
    const res = await fetch(`/public/${encodeURIComponent(name)}/${filePath}`);
    if (!res.ok) throw new Error("Failed to load file");

    fileMime = res.headers.get("content-type") ?? "";
    const baseMime = fileMime.split(";")[0].trim();

    if (TEXT_TYPES.has(baseMime)) {
      fileContent = await res.text();
    } else if (IMAGE_TYPES.has(baseMime)) {
      const blob = await res.blob();
      fileContent = URL.createObjectURL(blob);
    } else {
      fileContent = null;
    }
  } catch {
    fileContent = null;
  } finally {
    fileLoading = false;
  }
}

function navigateUp() {
  path = path.slice(0, -1);
}

function navigateToRoot() {
  path = [];
}

let baseMime = $derived(fileMime.split(";")[0].trim());
let isImage = $derived(IMAGE_TYPES.has(baseMime));
let isText = $derived(TEXT_TYPES.has(baseMime));

let sortedEntries = $derived(
  [...entries].sort((a, b) => {
    if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name);
  }),
);
</script>

<div class="public-files">
  {#if loading}
    <div class="empty">Loading...</div>
  {:else if error}
    <div class="empty error-text">{error}</div>
  {:else}
    <div class="browser">
      <div class="file-list">
        <div class="breadcrumb">
          <button class="crumb" onclick={navigateToRoot}>{rootLabel ?? "public"}/</button>
          {#each path as segment, i (i)}
            <button class="crumb" onclick={() => (path = path.slice(0, i + 1))}>{segment}/</button>
          {/each}
        </div>
        {#if path.length > 0}
          <button class="file-row" onclick={navigateUp}>
            <span class="file-icon">..</span>
            <span class="file-name">..</span>
          </button>
        {/if}
        {#each sortedEntries as entry (entry.name)}
          <button
            class="file-row"
            class:active={selectedFile === entry.name}
            onclick={() => selectFile(entry)}
          >
            <span class="file-icon">{entry.type === "directory" ? "\u{1F4C1}" : "\u{1F4C4}"}</span>
            <span class="file-name">{entry.name}{entry.type === "directory" ? "/" : ""}</span>
          </button>
        {/each}
        {#if entries.length === 0}
          <div class="empty-dir">Empty directory</div>
        {/if}
      </div>

      <div class="preview">
        {#if selectedFile}
          <div class="preview-header">
            <span class="preview-filename">{currentDir}{selectedFile}</span>
            <a
              class="preview-link"
              href="/public/{encodeURIComponent(name)}/{currentDir}{selectedFile}"
              target="_blank"
              rel="noopener"
            >open</a>
          </div>
          {#if fileLoading}
            <div class="preview-empty">Loading...</div>
          {:else if isImage && fileContent}
            <div class="preview-image">
              <img src={fileContent} alt={selectedFile} />
            </div>
          {:else if isText && fileContent !== null}
            <pre class="preview-text"><code>{fileContent}</code></pre>
          {:else}
            <div class="preview-empty">
              <span class="preview-mime">{fileMime || "unknown type"}</span>
              <a
                class="download-link"
                href="/public/{encodeURIComponent(name)}/{currentDir}{selectedFile}"
                target="_blank"
                rel="noopener"
              >Download</a>
            </div>
          {/if}
        {:else}
          <div class="preview-empty">Select a file to preview</div>
        {/if}
      </div>
    </div>
  {/if}
</div>

<style>
  .public-files {
    height: 100%;
    display: flex;
    flex-direction: column;
  }

  .empty {
    color: var(--text-2);
    font-size: 12px;
    padding: 24px;
    text-align: center;
  }

  .error-text {
    color: var(--red);
  }

  .browser {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
  }

  .file-list {
    flex-shrink: 0;
    max-height: 40%;
    border-bottom: 1px solid var(--border);
    overflow: auto;
    display: flex;
    flex-direction: column;
  }

  .breadcrumb {
    display: flex;
    flex-wrap: wrap;
    padding: 8px 10px;
    font-size: 11px;
    border-bottom: 1px solid var(--border);
    gap: 0;
  }

  .crumb {
    background: none;
    color: var(--accent);
    font-family: var(--mono);
    font-size: 11px;
    padding: 0;
    cursor: pointer;
  }

  .crumb:hover {
    text-decoration: underline;
  }

  .file-row {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 10px;
    font-size: 12px;
    color: var(--text-1);
    background: none;
    text-align: left;
    cursor: pointer;
    width: 100%;
    border-bottom: 1px solid var(--border);
  }

  .file-row:last-child {
    border-bottom: none;
  }

  .file-row:hover {
    background: var(--bg-2);
  }

  .file-row.active {
    background: var(--accent-bg);
    color: var(--accent);
  }

  .file-icon {
    font-size: 11px;
    flex-shrink: 0;
  }

  .file-name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--mono);
  }

  .empty-dir {
    color: var(--text-2);
    font-size: 11px;
    padding: 16px;
    text-align: center;
  }

  .preview {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
    overflow: hidden;
  }

  .preview-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 12px;
    border-bottom: 1px solid var(--border);
    font-size: 12px;
    flex-shrink: 0;
  }

  .preview-filename {
    font-family: var(--mono);
    color: var(--text-1);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .preview-link {
    color: var(--accent);
    font-size: 11px;
    text-decoration: none;
    flex-shrink: 0;
    margin-left: 8px;
  }

  .preview-link:hover {
    text-decoration: underline;
  }

  .preview-empty {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    color: var(--text-2);
    font-size: 12px;
  }

  .preview-mime {
    font-family: var(--mono);
    font-size: 11px;
  }

  .download-link {
    color: var(--accent);
    font-size: 12px;
    text-decoration: none;
  }

  .download-link:hover {
    text-decoration: underline;
  }

  .preview-text {
    flex: 1;
    overflow: auto;
    padding: 12px;
    background: var(--bg-0);
    font-family: var(--mono);
    font-size: 12px;
    line-height: 1.6;
    color: var(--text-0);
    white-space: pre-wrap;
    word-break: break-word;
    margin: 0;
  }

  .preview-text code {
    font-family: inherit;
    font-size: inherit;
  }

  .preview-image {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
    overflow: auto;
    background: var(--bg-0);
  }

  .preview-image img {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
    border-radius: var(--radius);
  }
</style>
