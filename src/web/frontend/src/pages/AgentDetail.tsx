import { useCallback, useEffect, useState } from "react";
import { FileEditor } from "../components/FileEditor";
import { History } from "../components/History";
import { LogViewer } from "../components/LogViewer";
import { StatusBadge } from "../components/StatusBadge";
import { VariantList } from "../components/VariantList";
import { type Agent, fetchAgent, startAgent, stopAgent } from "../lib/api";

const TABS = ["History", "Logs", "Files", "Variants", "Connections"] as const;
type Tab = (typeof TABS)[number];

export function AgentDetail({ name }: { name: string }) {
  const [agent, setAgent] = useState<Agent | null>(null);
  const [tab, setTab] = useState<Tab>("History");
  const [error, setError] = useState("");
  const [actionLoading, setActionLoading] = useState(false);

  const refresh = useCallback(() => {
    fetchAgent(name)
      .then((a) => {
        setAgent(a);
        setError("");
      })
      .catch(() => setError("Agent not found"));
  }, [name]);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 5000);
    return () => clearInterval(interval);
  }, [refresh]);

  const handleStart = async () => {
    setActionLoading(true);
    try {
      await startAgent(name);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to start");
    }
    setActionLoading(false);
  };

  const handleStop = async () => {
    setActionLoading(true);
    try {
      await stopAgent(name);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to stop");
    }
    setActionLoading(false);
  };

  if (error && !agent) {
    return <div style={{ color: "var(--red)", padding: 24 }}>{error}</div>;
  }

  if (!agent) {
    return <div style={{ color: "var(--text-2)", padding: 24 }}>Loading...</div>;
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "calc(100vh - 48px - 48px)",
        animation: "fadeIn 0.2s ease both",
      }}
    >
      {/* Agent header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 16,
          flexShrink: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <StatusBadge status={agent.status} />
          <span style={{ color: "var(--text-2)", fontSize: 12 }}>:{agent.port}</span>
          {agent.channels
            .filter((ch) => ch.name !== "web" && ch.status === "connected")
            .map((ch) => (
              <StatusBadge key={ch.name} status="connected" />
            ))}
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {agent.hasPages && (
            <a
              href={`/pages/${agent.name}/`}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                padding: "6px 16px",
                background: "var(--bg-2)",
                color: "var(--text-1)",
                borderRadius: "var(--radius)",
                fontSize: 12,
                fontWeight: 500,
                textDecoration: "none",
                border: "1px solid var(--border)",
              }}
            >
              Pages
            </a>
          )}
          {agent.status === "stopped" ? (
            <button
              onClick={handleStart}
              disabled={actionLoading}
              style={{
                padding: "6px 16px",
                background: "var(--accent-dim)",
                color: "var(--accent)",
                borderRadius: "var(--radius)",
                fontSize: 12,
                fontWeight: 500,
                opacity: actionLoading ? 0.5 : 1,
                transition: "opacity 0.15s",
              }}
            >
              {actionLoading ? "Starting..." : "Start"}
            </button>
          ) : (
            <button
              onClick={handleStop}
              disabled={actionLoading}
              style={{
                padding: "6px 16px",
                background: "var(--red-dim)",
                color: "var(--red)",
                borderRadius: "var(--radius)",
                fontSize: 12,
                fontWeight: 500,
                opacity: actionLoading ? 0.5 : 1,
                transition: "opacity 0.15s",
              }}
            >
              {actionLoading ? "Stopping..." : "Stop"}
            </button>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div
        style={{
          display: "flex",
          gap: 0,
          borderBottom: "1px solid var(--border)",
          marginBottom: 0,
          flexShrink: 0,
        }}
      >
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              padding: "8px 16px",
              background: "transparent",
              color: t === tab ? "var(--accent)" : "var(--text-2)",
              fontSize: 12,
              fontWeight: 500,
              borderBottom: t === tab ? "2px solid var(--accent)" : "2px solid transparent",
              transition: "all 0.15s",
              marginBottom: -1,
            }}
          >
            {t}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div style={{ flex: 1, overflow: "hidden", paddingTop: 12 }}>
        {tab === "History" && <History name={name} />}
        {tab === "Logs" && <LogViewer name={name} />}
        {tab === "Files" && <FileEditor name={name} />}
        {tab === "Variants" && <VariantList name={name} />}
        {tab === "Connections" && <ConnectionsTab agent={agent} />}
      </div>
    </div>
  );
}

function ConnectionsTab({ agent }: { agent: Agent }) {
  // Filter to external channels (not web) that are connected
  const connectedChannels = agent.channels.filter(
    (ch) => ch.name !== "web" && ch.status === "connected",
  );

  if (connectedChannels.length === 0) {
    return (
      <div style={{ color: "var(--text-2)", padding: 24, textAlign: "center" }}>
        No active connections.
      </div>
    );
  }

  return (
    <div style={{ padding: "8px 0", display: "flex", flexDirection: "column", gap: 12 }}>
      {connectedChannels.map((channel) => (
        <div
          key={channel.name}
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 16,
            padding: 16,
            background: "var(--bg-2)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-lg)",
          }}
        >
          <div
            style={{
              width: 40,
              height: 40,
              borderRadius: "var(--radius)",
              background: "var(--bg-3)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 18,
              color: "var(--accent)",
              flexShrink: 0,
            }}
          >
            ⦿
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                marginBottom: 6,
              }}
            >
              <span style={{ fontWeight: 600, color: "var(--text-0)" }}>{channel.displayName}</span>
              <StatusBadge status="connected" />
            </div>
            {channel.username && (
              <div style={{ fontSize: 13, color: "var(--text-1)", marginBottom: 4 }}>
                Bot: <span style={{ color: "var(--text-0)" }}>{channel.username}</span>
              </div>
            )}
            {channel.connectedAt && (
              <div style={{ fontSize: 11, color: "var(--text-2)" }}>
                Connected {formatRelativeTime(channel.connectedAt)}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
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
