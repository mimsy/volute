<script lang="ts">
let { onComplete }: { onComplete: () => void } = $props();

let step = $state<"name" | "done">("name");
let systemName = $state("");
let error = $state("");
let loading = $state(false);

async function handleSubmit(e: Event) {
  e.preventDefault();
  if (!systemName.trim()) return;
  error = "";
  loading = true;

  try {
    const res = await fetch("/api/setup/configure", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: systemName.trim() }),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(data.error || `Setup failed: ${res.status}`);
    }
    step = "done";
  } catch (err) {
    error = err instanceof Error ? err.message : "Something went wrong";
  }
  loading = false;
}
</script>

<div class="container">
  <div class="card">
    <div class="branding">
      <div class="logo-row">
        <span class="logo-wrap">
          <img src="/logo.png" alt="" class="login-spiral" />
          <span class="hover-dot"></span>
        </span>
        <span class="logo">volute</span>
      </div>
    </div>

    {#if step === "name"}
      <div class="subtitle">Welcome! Let's set up your system.</div>
      <form onsubmit={handleSubmit}>
        <label class="label" for="system-name">System name</label>
        <!-- svelte-ignore a11y_autofocus -->
        <input
          id="system-name"
          type="text"
          placeholder="e.g. my-server"
          bind:value={systemName}
          class="input"
          autofocus
        />
        <div class="hint">A name to identify this Volute installation.</div>
        {#if error}
          <div class="error">{error}</div>
        {/if}
        <button
          type="submit"
          disabled={loading || !systemName.trim()}
          class="submit-btn"
          style:opacity={loading ? 0.5 : 1}
        >
          {loading ? "Setting up..." : "Continue"}
        </button>
      </form>
    {:else}
      <div class="done">
        <div class="done-icon">&#10003;</div>
        <div class="done-text">Setup complete!</div>
        <div class="done-hint">Create an account to get started.</div>
        <button class="submit-btn" onclick={onComplete}>Continue to login</button>
      </div>
    {/if}
  </div>
</div>

<style>
  .container {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    padding: 24px;
  }

  .card {
    width: 360px;
    padding: 32px;
    background: var(--bg-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
  }

  .branding {
    margin-bottom: 24px;
    text-align: center;
  }

  .logo-row {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    margin-bottom: 4px;
  }

  .logo-wrap {
    position: relative;
    width: 34px;
    height: 34px;
    flex-shrink: 0;
  }

  .login-spiral {
    width: 34px;
    height: 34px;
    filter: invert(1);
    transition: opacity 0.15s;
  }

  .hover-dot {
    position: absolute;
    inset: 0;
    margin: auto;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    opacity: 0;
    transition: opacity 0.15s;
    animation: iridescent 3s ease-in-out infinite;
  }

  .card:hover .login-spiral {
    opacity: 0;
  }

  .card:hover .hover-dot {
    opacity: 1;
  }

  .logo {
    font-family: var(--display);
    font-size: 31px;
    font-weight: 300;
    color: var(--text-0);
    letter-spacing: 0.04em;
    margin-top: -4px;
  }

  @keyframes iridescent {
    0%   { background: #4ade80; }
    16%  { background: #60a5fa; }
    33%  { background: #c084fc; }
    50%  { background: #f472b6; }
    66%  { background: #fbbf24; }
    83%  { background: #34d399; }
    100% { background: #4ade80; }
  }

  .subtitle {
    color: var(--text-1);
    font-size: 14px;
    margin-bottom: 20px;
    text-align: center;
  }

  .label {
    display: block;
    color: var(--text-1);
    font-size: 13px;
    margin-bottom: 6px;
  }

  .input {
    width: 100%;
    padding: 10px 12px;
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--text-0);
    font-family: inherit;
    font-size: 14px;
    outline: none;
  }

  .input:focus {
    border-color: var(--border-bright);
  }

  .hint {
    color: var(--text-2);
    font-size: 12px;
    margin-top: 6px;
  }

  .error {
    color: var(--red);
    font-size: 13px;
    margin-top: 8px;
  }

  .submit-btn {
    width: 100%;
    padding: 10px 16px;
    margin-top: 16px;
    background: var(--accent-dim);
    color: var(--accent);
    border-radius: var(--radius);
    font-size: 14px;
    font-weight: 500;
    font-family: inherit;
    border: none;
    cursor: pointer;
  }

  .done {
    text-align: center;
  }

  .done-icon {
    font-size: 32px;
    color: var(--green);
    margin-bottom: 12px;
  }

  .done-text {
    font-size: 18px;
    font-weight: 500;
    color: var(--text-0);
    margin-bottom: 8px;
  }

  .done-hint {
    color: var(--text-2);
    font-size: 13px;
    margin-bottom: 16px;
  }
</style>
