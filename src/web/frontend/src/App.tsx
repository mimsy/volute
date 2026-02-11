import { useEffect, useState } from "react";
import { LoginPage } from "./components/LoginPage";
import { SystemLogs } from "./components/SystemLogs";
import { UpdateBanner } from "./components/UpdateBanner";
import { UserManagement } from "./components/UserManagement";
import { type AuthUser, fetchMe, logout } from "./lib/auth";
import { AgentDetail } from "./pages/AgentDetail";
import { Chats } from "./pages/Chats";
import { Dashboard } from "./pages/Dashboard";

function parseHash(): { page: string; name?: string; conversationId?: string } {
  const hash = window.location.hash.slice(1) || "/";
  if (hash === "/logs") return { page: "logs" };
  if (hash === "/chats") return { page: "chats" };
  const chatsMatch = hash.match(/^\/chats\/(.+)$/);
  if (chatsMatch) return { page: "chats", conversationId: chatsMatch[1] };
  const match = hash.match(/^\/agent\/(.+)$/);
  if (match) return { page: "agent", name: match[1] };
  return { page: "dashboard" };
}

export function App() {
  const [route, setRoute] = useState(parseHash);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [showUsers, setShowUsers] = useState(false);

  useEffect(() => {
    fetchMe().then((u) => {
      setUser(u);
      setAuthChecked(true);
    });
  }, []);

  useEffect(() => {
    const handler = () => setRoute(parseHash());
    window.addEventListener("hashchange", handler);
    return () => window.removeEventListener("hashchange", handler);
  }, []);

  const handleLogout = async () => {
    await logout();
    setUser(null);
  };

  if (!authChecked) {
    return (
      <>
        <style>{globalStyles}</style>
        <div className="app">
          <div style={{ color: "var(--text-2)", padding: 24, textAlign: "center" }}>Loading...</div>
        </div>
      </>
    );
  }

  if (!user) {
    return (
      <>
        <style>{globalStyles}</style>
        <div className="app" style={{ height: "100%" }}>
          <LoginPage onAuth={setUser} />
        </div>
      </>
    );
  }

  return (
    <>
      <style>{globalStyles}</style>
      <div className="app">
        {user.role === "admin" && <UpdateBanner />}
        <header className="app-header">
          <a href="#/" className="logo">
            <span className="logo-symbol">&gt;</span> volute
          </a>
          {route.page === "agent" && route.name && (
            <nav className="breadcrumb">
              <span className="breadcrumb-sep">/</span>
              <span className="breadcrumb-name">{route.name}</span>
            </nav>
          )}
          {route.page === "chats" && (
            <nav className="breadcrumb">
              <span className="breadcrumb-sep">/</span>
              <span className="breadcrumb-name">chats</span>
            </nav>
          )}
          {route.page === "logs" && (
            <nav className="breadcrumb">
              <span className="breadcrumb-sep">/</span>
              <span className="breadcrumb-name">system logs</span>
            </nav>
          )}
          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 12 }}>
            <a
              href="#/chats"
              style={{
                color: route.page === "chats" ? "var(--accent)" : "var(--text-2)",
                fontSize: 12,
                fontFamily: "var(--mono)",
                transition: "color 0.15s",
              }}
              onMouseEnter={(e) => {
                if (route.page !== "chats") e.currentTarget.style.color = "var(--text-0)";
              }}
              onMouseLeave={(e) => {
                if (route.page !== "chats") e.currentTarget.style.color = "var(--text-2)";
              }}
            >
              chats
            </a>
            {user.role === "admin" && (
              <a
                href="#/logs"
                style={{
                  color: route.page === "logs" ? "var(--accent)" : "var(--text-2)",
                  fontSize: 12,
                  fontFamily: "var(--mono)",
                  transition: "color 0.15s",
                }}
                onMouseEnter={(e) => {
                  if (route.page !== "logs") e.currentTarget.style.color = "var(--text-0)";
                }}
                onMouseLeave={(e) => {
                  if (route.page !== "logs") e.currentTarget.style.color = "var(--text-2)";
                }}
              >
                logs
              </a>
            )}
            {user.role === "admin" && (
              <button
                onClick={() => setShowUsers(!showUsers)}
                style={{
                  background: "transparent",
                  color: "var(--text-2)",
                  fontSize: 12,
                  fontFamily: "var(--mono)",
                  border: "none",
                  cursor: "pointer",
                  transition: "color 0.15s",
                }}
                onMouseEnter={(e) => (e.currentTarget.style.color = "var(--text-0)")}
                onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-2)")}
              >
                users
              </button>
            )}
            <span style={{ color: "var(--text-2)", fontSize: 12 }}>{user.username}</span>
            <button
              onClick={handleLogout}
              style={{
                background: "transparent",
                color: "var(--text-2)",
                fontSize: 12,
                fontFamily: "var(--mono)",
                border: "none",
                cursor: "pointer",
                transition: "color 0.15s",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.color = "var(--text-0)")}
              onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-2)")}
            >
              logout
            </button>
          </div>
        </header>
        <main className="app-main">
          {showUsers ? (
            <UserManagement onClose={() => setShowUsers(false)} />
          ) : (
            <>
              {route.page === "dashboard" && <Dashboard />}
              {route.page === "chats" && (
                <Chats conversationId={route.conversationId} username={user.username} />
              )}
              {route.page === "agent" && route.name && <AgentDetail name={route.name} />}
              {route.page === "logs" && <SystemLogs />}
            </>
          )}
        </main>
      </div>
    </>
  );
}

const globalStyles = `
  :root {
    --bg-0: #0a0c0f;
    --bg-1: #11141a;
    --bg-2: #181c24;
    --bg-3: #1f2430;
    --border: #2a3040;
    --border-bright: #3a4560;
    --text-0: #e8ecf4;
    --text-1: #a0aabb;
    --text-2: #6a7588;
    --accent: #4ade80;
    --accent-dim: #22613e;
    --accent-bg: rgba(74, 222, 128, 0.08);
    --red: #f87171;
    --red-dim: #7f1d1d;
    --yellow: #fbbf24;
    --yellow-dim: #78350f;
    --blue: #60a5fa;
    --purple: #c084fc;
    --mono: 'IBM Plex Mono', 'SF Mono', 'Fira Code', monospace;
    --radius: 6px;
    --radius-lg: 10px;
  }

  * {
    margin: 0;
    padding: 0;
    box-sizing: border-box;
  }

  html, body, #root {
    height: 100%;
    background: var(--bg-0);
    color: var(--text-0);
    font-family: var(--mono);
    font-size: 13px;
    line-height: 1.6;
    -webkit-font-smoothing: antialiased;
  }

  ::selection {
    background: var(--accent-dim);
    color: var(--accent);
  }

  ::-webkit-scrollbar {
    width: 6px;
    height: 6px;
  }
  ::-webkit-scrollbar-track {
    background: transparent;
  }
  ::-webkit-scrollbar-thumb {
    background: var(--border);
    border-radius: 3px;
  }
  ::-webkit-scrollbar-thumb:hover {
    background: var(--border-bright);
  }

  a {
    color: inherit;
    text-decoration: none;
  }

  button {
    font-family: var(--mono);
    cursor: pointer;
    border: none;
  }

  button:focus {
    outline: none;
  }

  button:focus-visible {
    outline: 1px solid var(--accent);
    outline-offset: 2px;
  }

  a:focus-visible {
    outline: 1px solid var(--accent);
    outline-offset: 2px;
  }

  .app {
    height: 100%;
    display: flex;
    flex-direction: column;
  }

  .app-header {
    display: flex;
    align-items: center;
    gap: 0;
    padding: 0 24px;
    height: 48px;
    background: var(--bg-1);
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }

  .logo {
    font-family: var(--mono);
    font-size: 15px;
    font-weight: 600;
    letter-spacing: -0.02em;
    color: var(--text-0);
    display: flex;
    align-items: center;
    gap: 0;
  }

  .logo-symbol {
    color: var(--accent);
    margin-right: 6px;
  }

  .logo:hover .logo-symbol {
    text-shadow: 0 0 8px var(--accent);
  }

  .breadcrumb {
    display: flex;
    align-items: center;
    font-size: 13px;
  }

  .breadcrumb-sep {
    color: var(--text-2);
    margin: 0 8px;
  }

  .breadcrumb-name {
    color: var(--text-1);
  }

  .app-main {
    flex: 1;
    overflow: auto;
    padding: 24px;
  }

  @keyframes fadeIn {
    from { opacity: 0; transform: translateY(6px); }
    to { opacity: 1; transform: translateY(0); }
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.5; }
  }

  @keyframes slideIn {
    from { opacity: 0; transform: translateX(-8px); }
    to { opacity: 1; transform: translateX(0); }
  }

  /* Markdown rendering */
  .markdown-body {
    word-break: break-word;
    color: var(--text-0);
    line-height: 1.6;
  }
  .markdown-body p {
    margin: 0 0 8px;
  }
  .markdown-body p:last-child {
    margin-bottom: 0;
  }
  .markdown-body pre {
    background: var(--bg-3);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 10px 12px;
    overflow-x: auto;
    margin: 8px 0;
    font-size: 12px;
    line-height: 1.5;
  }
  .markdown-body code {
    font-family: var(--mono);
    font-size: 12px;
    background: var(--bg-3);
    padding: 1px 4px;
    border-radius: 3px;
  }
  .markdown-body pre code {
    background: none;
    padding: 0;
  }
  .markdown-body a {
    color: var(--blue);
    text-decoration: underline;
  }
  .markdown-body ul, .markdown-body ol {
    margin: 4px 0;
    padding-left: 20px;
  }
  .markdown-body li {
    margin: 2px 0;
  }
  .markdown-body h1, .markdown-body h2, .markdown-body h3,
  .markdown-body h4, .markdown-body h5, .markdown-body h6 {
    margin: 12px 0 6px;
    font-weight: 600;
    color: var(--text-0);
  }
  .markdown-body h1 { font-size: 18px; }
  .markdown-body h2 { font-size: 16px; }
  .markdown-body h3 { font-size: 14px; }
  .markdown-body blockquote {
    border-left: 3px solid var(--border-bright);
    margin: 8px 0;
    padding: 4px 12px;
    color: var(--text-1);
  }
  .markdown-body table {
    border-collapse: collapse;
    margin: 8px 0;
  }
  .markdown-body th, .markdown-body td {
    border: 1px solid var(--border);
    padding: 6px 10px;
    font-size: 12px;
  }
  .markdown-body th {
    background: var(--bg-3);
    font-weight: 600;
  }
  .markdown-body hr {
    border: none;
    border-top: 1px solid var(--border);
    margin: 12px 0;
  }
`;
