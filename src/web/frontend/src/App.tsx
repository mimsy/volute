import { useState, useEffect } from "react";
import { Dashboard } from "./pages/Dashboard";
import { AgentDetail } from "./pages/AgentDetail";

function parseHash(): { page: string; name?: string } {
  const hash = window.location.hash.slice(1) || "/";
  const match = hash.match(/^\/agent\/(.+)$/);
  if (match) return { page: "agent", name: match[1] };
  return { page: "dashboard" };
}

export function App() {
  const [route, setRoute] = useState(parseHash);

  useEffect(() => {
    const handler = () => setRoute(parseHash());
    window.addEventListener("hashchange", handler);
    return () => window.removeEventListener("hashchange", handler);
  }, []);

  return (
    <>
      <style>{globalStyles}</style>
      <div className="app">
        <header className="app-header">
          <a href="#/" className="logo">
            <span className="logo-symbol">&gt;</span> molt
          </a>
          {route.page === "agent" && route.name && (
            <nav className="breadcrumb">
              <span className="breadcrumb-sep">/</span>
              <span className="breadcrumb-name">{route.name}</span>
            </nav>
          )}
        </header>
        <main className="app-main">
          {route.page === "dashboard" && <Dashboard />}
          {route.page === "agent" && route.name && (
            <AgentDetail name={route.name} />
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
    --sans: 'Space Grotesk', system-ui, sans-serif;
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
    outline: none;
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
`;
