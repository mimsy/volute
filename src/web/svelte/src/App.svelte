<script lang="ts">
import LoginPage from "./components/LoginPage.svelte";
import SystemLogs from "./components/SystemLogs.svelte";
import UpdateBanner from "./components/UpdateBanner.svelte";
import UserManagement from "./components/UserManagement.svelte";
import { fetchSystemInfo } from "./lib/api";
import { type AuthUser, fetchMe, logout } from "./lib/auth";
import { navigate } from "./lib/navigate";
import Chats from "./pages/Chats.svelte";
import Dashboard from "./pages/Dashboard.svelte";
import Home from "./pages/Home.svelte";
import MindDetail from "./pages/MindDetail.svelte";

type Route = {
  page: string;
  name?: string;
  conversationId?: string;
  mindName?: string;
};

function parseRoute(): Route {
  const path = window.location.pathname;
  const search = new URLSearchParams(window.location.search);
  if (path === "/" || path === "") return { page: "home" };
  if (path === "/minds") return { page: "minds" };
  if (path === "/chats") {
    const mind = search.get("mind");
    return mind ? { page: "chats", mindName: mind } : { page: "chats" };
  }
  if (path === "/logs") return { page: "logs" };
  const chatsMatch = path.match(/^\/chats\/(.+)$/);
  if (chatsMatch) return { page: "chats", conversationId: chatsMatch[1] };
  const match = path.match(/^\/mind\/(.+)$/);
  if (match) return { page: "mind", name: match[1] };
  return { page: "home" };
}

let route = $state<Route>(parseRoute());
let user = $state<AuthUser | null>(null);
let authChecked = $state(false);
let showUsers = $state(false);
let systemName = $state<string | null>(null);
let userMenuOpen = $state(false);

$effect(() => {
  fetchMe().then(async (u) => {
    user = u;
    authChecked = true;
    if (u) {
      const info = await fetchSystemInfo();
      systemName = info.system;
    }
  });
});

$effect(() => {
  const handler = () => {
    route = parseRoute();
    showUsers = false;
  };
  window.addEventListener("popstate", handler);
  // Intercept internal link clicks for SPA navigation
  const handleClick = (e: MouseEvent) => {
    const link = (e.target as Element).closest("a");
    if (!link) return;
    const href = link.getAttribute("href");
    if (!href || href.startsWith("http") || href.startsWith("//") || link.target === "_blank")
      return;
    if (e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    navigate(href);
  };
  document.addEventListener("click", handleClick);
  return () => {
    window.removeEventListener("popstate", handler);
    document.removeEventListener("click", handleClick);
  };
});

async function handleLogout() {
  await logout();
  user = null;
}

async function handleAuth(u: AuthUser) {
  user = u;
  const info = await fetchSystemInfo();
  systemName = info.system;
}

const breadcrumbLabel: Record<string, string> = {
  minds: "minds",
  chats: "chat",
  logs: "system logs",
};

let breadcrumb = $derived(route.page === "mind" ? route.name : breadcrumbLabel[route.page]);
</script>

{#if !authChecked}
  <div class="app">
    <div class="loading">Loading...</div>
  </div>
{:else if !user}
  <div class="app full-height">
    <LoginPage onAuth={handleAuth} />
  </div>
{:else}
  <div class="app">
    {#if user.role === "admin"}
      <UpdateBanner />
    {/if}
    <header class="app-header">
      <a href="/" class="logo">
        <span class="logo-symbol">&gt;</span> volute
        {#if systemName}
          <span class="system-name"> &middot; {systemName}</span>
        {/if}
      </a>
      {#if breadcrumb}
        <nav class="breadcrumb">
          <span class="breadcrumb-sep">/</span>
          <span class="breadcrumb-name">{breadcrumb}</span>
        </nav>
      {/if}
      <div class="header-right">
        <a href="/chats" class="nav-link" class:active={route.page === "chats"}>chat</a>
        <a href="/minds" class="nav-link" class:active={route.page === "minds" || route.page === "mind"}>minds</a>
        <div class="user-menu">
          <button class="user-menu-button" class:open={userMenuOpen} onclick={() => userMenuOpen = !userMenuOpen}>
            {user.username}
            <span class="caret">{userMenuOpen ? "\u25B2" : "\u25BC"}</span>
          </button>
          {#if userMenuOpen}
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div class="overlay" onclick={() => userMenuOpen = false} onkeydown={() => {}}></div>
            <div class="dropdown">
              {#if user.role === "admin"}
                <button class="dropdown-item" class:active={route.page === "logs"} onclick={() => { navigate("/logs"); userMenuOpen = false; }}>
                  system logs
                </button>
                <button class="dropdown-item" onclick={() => { showUsers = !showUsers; userMenuOpen = false; }}>
                  manage users
                </button>
                <div class="dropdown-divider"></div>
              {/if}
              <button class="dropdown-item muted" onclick={() => { handleLogout(); userMenuOpen = false; }}>
                logout
              </button>
            </div>
          {/if}
        </div>
      </div>
    </header>
    <main class="app-main" class:no-padding={route.page === "chats" && !showUsers}>
      {#if showUsers}
        <UserManagement onClose={() => showUsers = false} />
      {:else if route.page === "home"}
        <Home username={user.username} />
      {:else if route.page === "minds"}
        <Dashboard />
      {:else if route.page === "chats"}
        <Chats
          conversationId={route.conversationId}
          mindName={route.mindName}
          username={user.username}
        />
      {:else if route.page === "mind" && route.name}
        <MindDetail name={route.name} />
      {:else if route.page === "logs"}
        <SystemLogs />
      {/if}
    </main>
  </div>
{/if}

<style>
  .loading {
    color: var(--text-2);
    padding: 24px;
    text-align: center;
  }

  .full-height {
    height: 100%;
  }

  .system-name {
    color: var(--text-2);
    font-weight: 400;
  }

  .header-right {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .nav-link {
    color: var(--text-2);
    font-size: 12px;
    font-family: var(--mono);
    transition: color 0.15s;
  }

  .nav-link:hover {
    color: var(--text-0);
  }

  .nav-link.active {
    color: var(--accent);
  }

  .user-menu {
    position: relative;
  }

  .user-menu-button {
    background: transparent;
    color: var(--text-2);
    font-size: 12px;
    font-family: var(--mono);
    border: none;
    cursor: pointer;
    transition: color 0.15s;
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .user-menu-button:hover,
  .user-menu-button.open {
    color: var(--text-0);
  }

  .caret {
    font-size: 8px;
  }

  .overlay {
    position: fixed;
    inset: 0;
    z-index: 99;
  }

  .dropdown {
    position: absolute;
    right: 0;
    top: 100%;
    margin-top: 6px;
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 4px 0;
    min-width: 120px;
    z-index: 100;
  }

  .dropdown-item {
    display: block;
    width: 100%;
    padding: 6px 12px;
    font-size: 12px;
    color: var(--text-1);
    background: transparent;
    text-align: left;
    font-family: var(--mono);
    transition: background 0.1s;
  }

  .dropdown-item:hover {
    background: var(--bg-3);
  }

  .dropdown-item.active {
    color: var(--accent);
  }

  .dropdown-item.muted {
    color: var(--text-2);
  }

  .dropdown-divider {
    border-top: 1px solid var(--border);
    margin: 4px 0;
  }

  .no-padding {
    padding: 0;
    overflow: hidden;
  }
</style>
