import { useEffect, useState } from "react";
import { AgentCard } from "../components/AgentCard";
import { SeedModal } from "../components/SeedModal";
import { type Agent, fetchAgents, fetchRecentPages, type RecentPage } from "../lib/api";

export function Dashboard() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [recentPages, setRecentPages] = useState<RecentPage[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [showSeedModal, setShowSeedModal] = useState(false);

  useEffect(() => {
    let active = true;
    const poll = async () => {
      try {
        const [data, pages] = await Promise.all([fetchAgents(), fetchRecentPages()]);
        if (active) {
          setAgents(data);
          setRecentPages(pages);
          setError("");
          setLoading(false);
        }
      } catch {
        if (active) {
          setError("Failed to connect to API");
          setLoading(false);
        }
      }
    };

    poll();
    const interval = setInterval(poll, 5000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, []);

  const handleSeedCreated = (agentName: string) => {
    setShowSeedModal(false);
    window.location.hash = `#/chats?agent=${agentName}`;
  };

  if (error) {
    return <div style={{ color: "var(--red)", padding: 40, textAlign: "center" }}>{error}</div>;
  }

  if (loading) {
    return null;
  }

  if (agents.length === 0) {
    return (
      <div
        style={{
          color: "var(--text-2)",
          padding: 40,
          textAlign: "center",
          fontSize: 14,
        }}
      >
        <div style={{ marginBottom: 8 }}>No agents registered.</div>
        <div style={{ display: "flex", gap: 12, justifyContent: "center", marginTop: 16 }}>
          <code style={{ color: "var(--text-1)" }}>volute agent create &lt;name&gt;</code>
          <span style={{ color: "var(--text-2)" }}>or</span>
          <button
            onClick={() => setShowSeedModal(true)}
            style={{
              padding: "4px 12px",
              background: "rgba(251, 191, 36, 0.08)",
              color: "var(--yellow)",
              borderRadius: "var(--radius)",
              fontSize: 12,
              fontWeight: 500,
              border: "1px solid rgba(251, 191, 36, 0.2)",
              cursor: "pointer",
            }}
          >
            plant a seed
          </button>
        </div>
        {showSeedModal && (
          <SeedModal onClose={() => setShowSeedModal(false)} onCreated={handleSeedCreated} />
        )}
      </div>
    );
  }

  return (
    <>
      <div style={{ marginBottom: 16 }}>
        <button
          onClick={() => setShowSeedModal(true)}
          style={{
            padding: "6px 14px",
            background: "rgba(251, 191, 36, 0.08)",
            color: "var(--yellow)",
            borderRadius: "var(--radius)",
            fontSize: 12,
            fontWeight: 500,
            border: "1px solid rgba(251, 191, 36, 0.2)",
            cursor: "pointer",
          }}
        >
          plant a seed
        </button>
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
          gap: 16,
          maxWidth: 1200,
        }}
      >
        {agents.map((agent, i) => (
          <div
            key={agent.name}
            style={{
              animation: "fadeIn 0.3s ease both",
              animationDelay: `${i * 50}ms`,
            }}
          >
            <AgentCard agent={agent} />
          </div>
        ))}
      </div>
      {recentPages.length > 0 && (
        <div style={{ marginTop: 32 }}>
          <h3
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: "var(--text-1)",
              marginBottom: 12,
              textTransform: "uppercase",
              letterSpacing: "0.05em",
            }}
          >
            Recent Pages
          </h3>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 4,
              maxWidth: 600,
            }}
          >
            {recentPages.map((page) => (
              <a
                key={`${page.agent}/${page.file}`}
                href={page.url}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  padding: "8px 12px",
                  background: "var(--bg-2)",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius)",
                  textDecoration: "none",
                  color: "var(--text-0)",
                  fontSize: 13,
                }}
              >
                <span>
                  <span style={{ color: "var(--text-2)" }}>{page.agent}/</span>
                  {page.file}
                </span>
                <span style={{ color: "var(--text-2)", fontSize: 11 }}>
                  {formatRelativeTime(page.modified)}
                </span>
              </a>
            ))}
          </div>
        </div>
      )}
      {showSeedModal && (
        <SeedModal onClose={() => setShowSeedModal(false)} onCreated={handleSeedCreated} />
      )}
    </>
  );
}

function formatRelativeTime(isoString: string): string {
  const date = new Date(isoString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${diffDays}d ago`;
}
