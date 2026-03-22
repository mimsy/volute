<script lang="ts">
import { type AuthUser, login, register } from "../lib/auth";
import Input from "./ui/Input.svelte";

let { onAuth }: { onAuth: (user: AuthUser) => void } = $props();

let mode = $state<"login" | "register">("login");
let username = $state("");
let password = $state("");
let error = $state("");
let loading = $state(false);
let pendingMessage = $state("");

async function handleSubmit(e: Event) {
  e.preventDefault();
  if (!username.trim() || !password.trim()) return;
  error = "";
  loading = true;

  try {
    if (mode === "login") {
      const user = await login(username, password);
      if (user.role === "pending") {
        pendingMessage = "Your account is pending approval by an admin.";
      } else {
        onAuth(user);
      }
    } else {
      const user = await register(username, password);
      if (user.role === "admin") {
        onAuth(user);
      } else {
        pendingMessage = "Account created. Waiting for admin approval.";
      }
    }
  } catch (err) {
    error = err instanceof Error ? err.message : "Something went wrong";
  }
  loading = false;
}
</script>

{#if pendingMessage}
  <div class="container">
    <div class="card">
      <div class="pending-msg">{pendingMessage}</div>
      <button class="link-btn" onclick={() => { pendingMessage = ""; mode = "login"; }}>
        Back to login
      </button>
    </div>
  </div>
{:else}
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
        <div class="subtitle">
          {mode === "login" ? "Sign in to continue" : "Create an account"}
        </div>
      </div>

      <form onsubmit={handleSubmit}>
        <Input
          type="text"
          placeholder="username"
          bind:value={username}
        />
        <Input
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
          {loading ? "..." : mode === "login" ? "Sign in" : "Create account"}
        </button>
      </form>

      <div class="toggle">
        <button class="link-btn" onclick={() => { mode = mode === "login" ? "register" : "login"; error = ""; }}>
          {mode === "login" ? "Need an account? Register" : "Have an account? Sign in"}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .container {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    padding: 24px;
  }

  .card {
    width: 320px;
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
    font-size: 13px;
    font-family: inherit;
    border: none;
    cursor: pointer;
    padding: 0;
  }

  .toggle {
    margin-top: 16px;
    text-align: center;
  }

  .pending-msg {
    color: var(--yellow);
    margin-bottom: 16px;
  }
</style>
