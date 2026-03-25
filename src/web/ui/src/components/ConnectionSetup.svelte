<script lang="ts">
import { Input } from "@volute/ui";
import type { AuthUser } from "../lib/auth";
import { connectRemote, probeRemote, remoteLogin } from "../lib/daemon-connection.svelte";

let { onConnected }: { onConnected: (user: AuthUser) => void } = $props();

let step = $state<"url" | "login">("url");
let daemonUrl = $state("");
let username = $state("");
let password = $state("");
let error = $state("");
let loading = $state(false);

async function handleUrlSubmit(e: Event) {
  e.preventDefault();
  if (!daemonUrl.trim()) return;
  error = "";
  loading = true;

  // Normalize: add https:// if no protocol
  let url = daemonUrl.trim();
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    url = `https://${url}`;
  }
  daemonUrl = url;

  const ok = await probeRemote(url);
  if (!ok) {
    // Try http if https failed
    if (url.startsWith("https://")) {
      const httpUrl = url.replace("https://", "http://");
      const httpOk = await probeRemote(httpUrl);
      if (httpOk) {
        daemonUrl = httpUrl;
        loading = false;
        step = "login";
        return;
      }
    }
    error = "Could not reach daemon at this address";
    loading = false;
    return;
  }

  loading = false;
  step = "login";
}

async function handleLogin(e: Event) {
  e.preventDefault();
  if (!username.trim() || !password.trim()) return;
  error = "";
  loading = true;

  try {
    const { token, user } = await remoteLogin(daemonUrl, username, password);
    await connectRemote(daemonUrl, token);
    onConnected(user as AuthUser);
  } catch (err) {
    error = err instanceof Error ? err.message : "Login failed";
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
      <div class="subtitle">Connect to a daemon</div>
    </div>

    {#if step === "url"}
      <form onsubmit={handleUrlSubmit}>
        <Input
          inputSize="md"
          type="text"
          placeholder="daemon address (e.g. mybox.tailnet:1618)"
          bind:value={daemonUrl}
        />
        {#if error}
          <div class="error">{error}</div>
        {/if}
        <button
          type="submit"
          disabled={loading || !daemonUrl.trim()}
          class="submit-btn"
          style:opacity={loading ? 0.5 : 1}
        >
          {loading ? "Connecting..." : "Connect"}
        </button>
      </form>
    {:else}
      <div class="daemon-info">
        <span class="daemon-url">{daemonUrl}</span>
        <button class="link-btn" onclick={() => { step = "url"; error = ""; }}>change</button>
      </div>
      <form onsubmit={handleLogin}>
        <Input
          inputSize="md"
          type="text"
          placeholder="username"
          bind:value={username}
        />
        <Input
          inputSize="md"
          type="password"
          placeholder="password"
          bind:value={password}
          style="margin-top:8px"
        />
        {#if error}
          <div class="error">{error}</div>
        {/if}
        <button
          type="submit"
          disabled={loading || !username.trim() || !password.trim()}
          class="submit-btn"
          style:opacity={loading ? 0.5 : 1}
        >
          {loading ? "Signing in..." : "Sign in"}
        </button>
      </form>
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

  .subtitle {
    color: var(--text-2);
    font-size: 13px;
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

  .daemon-info {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 16px;
    padding: 8px 12px;
    background: var(--bg-2);
    border-radius: var(--radius);
    font-size: 13px;
  }

  .daemon-url {
    color: var(--text-1);
    font-family: var(--mono);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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

  .link-btn {
    background: transparent;
    color: var(--text-2);
    font-size: 12px;
    font-family: inherit;
    border: none;
    cursor: pointer;
    padding: 0;
    flex-shrink: 0;
  }
</style>
