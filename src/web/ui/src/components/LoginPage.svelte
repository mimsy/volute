<script lang="ts">
import { type AuthUser, login, register } from "../lib/auth";

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
        <div class="logo"><span class="accent">&gt;</span> volute</div>
        <div class="subtitle">
          {mode === "login" ? "Sign in to continue" : "Create an account"}
        </div>
      </div>

      <form onsubmit={handleSubmit}>
        <input
          type="text"
          placeholder="username"
          bind:value={username}
          class="input"
        />
        <input
          type="password"
          placeholder="password"
          bind:value={password}
          class="input mt-8"
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

  .logo {
    font-size: 18px;
    font-weight: 600;
    margin-bottom: 4px;
  }

  .accent {
    color: var(--accent);
  }

  .subtitle {
    color: var(--text-2);
    font-size: 12px;
  }

  .input {
    width: 100%;
    padding: 10px 12px;
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--text-0);
    font-family: var(--mono);
    font-size: 13px;
    outline: none;
  }

  .input:focus {
    border-color: var(--border-bright);
  }

  .mt-8 {
    margin-top: 8px;
  }

  .error {
    color: var(--red);
    font-size: 12px;
    margin-top: 8px;
  }

  .submit-btn {
    width: 100%;
    padding: 10px 16px;
    margin-top: 16px;
    background: var(--accent-dim);
    color: var(--accent);
    border-radius: var(--radius);
    font-size: 13px;
    font-weight: 500;
    font-family: var(--mono);
    border: none;
    cursor: pointer;
  }

  .link-btn {
    background: transparent;
    color: var(--text-2);
    font-size: 12px;
    font-family: var(--mono);
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
