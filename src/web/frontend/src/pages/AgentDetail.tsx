import { useState, useEffect } from "react";
import {
  fetchAgent,
  startAgent,
  stopAgent,
  type Agent,
} from "../lib/api";
import { StatusBadge } from "../components/StatusBadge";
import { Chat } from "../components/Chat";
import { LogViewer } from "../components/LogViewer";
import { FileEditor } from "../components/FileEditor";
import { VariantList } from "../components/VariantList";

const TABS = ["Chat", "Logs", "Files", "Variants"] as const;
type Tab = (typeof TABS)[number];

export function AgentDetail({ name }: { name: string }) {
  const [agent, setAgent] = useState<Agent | null>(null);
  const [tab, setTab] = useState<Tab>("Chat");
  const [error, setError] = useState("");
  const [actionLoading, setActionLoading] = useState(false);

  const refresh = () => {
    fetchAgent(name)
      .then((a) => {
        setAgent(a);
        setError("");
      })
      .catch(() => setError("Agent not found"));
  };

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 5000);
    return () => clearInterval(interval);
  }, [name]);

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
    return (
      <div style={{ color: "var(--red)", padding: 24 }}>{error}</div>
    );
  }

  if (!agent) {
    return (
      <div style={{ color: "var(--text-2)", padding: 24 }}>Loading...</div>
    );
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
        <div
          style={{ display: "flex", alignItems: "center", gap: 12 }}
        >
          <StatusBadge status={agent.status} />
          <span style={{ color: "var(--text-2)", fontSize: 12 }}>
            :{agent.port}
          </span>
          {agent.discord.status === "connected" && (
            <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <StatusBadge status="connected" />
              {agent.discord.username && (
                <span style={{ color: "var(--text-1)", fontSize: 11 }}>
                  {agent.discord.username}
                </span>
              )}
            </span>
          )}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
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
              borderBottom:
                t === tab
                  ? "2px solid var(--accent)"
                  : "2px solid transparent",
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
        {tab === "Chat" && <Chat name={name} />}
        {tab === "Logs" && <LogViewer name={name} />}
        {tab === "Files" && <FileEditor name={name} />}
        {tab === "Variants" && <VariantList name={name} />}
      </div>
    </div>
  );
}
