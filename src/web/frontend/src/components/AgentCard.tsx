import type { Agent } from "../lib/api";
import { StatusBadge } from "./StatusBadge";

export function AgentCard({ agent }: { agent: Agent }) {
  return (
    <a
      href={`#/agent/${agent.name}`}
      style={{
        display: "block",
        padding: 20,
        background: "var(--bg-2)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-lg)",
        cursor: "pointer",
        transition: "all 0.15s ease",
        animation: "fadeIn 0.3s ease both",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = "var(--border-bright)";
        e.currentTarget.style.background = "var(--bg-3)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = "var(--border)";
        e.currentTarget.style.background = "var(--bg-2)";
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 12,
        }}
      >
        <span
          style={{
            fontSize: 15,
            fontWeight: 600,
            color: "var(--text-0)",
          }}
        >
          {agent.name}
        </span>
        <StatusBadge status={agent.status} />
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 16,
          color: "var(--text-2)",
          fontSize: 12,
        }}
      >
        <span>:{agent.port}</span>
        {agent.discord.status === "connected" && (
          <StatusBadge status="connected" />
        )}
      </div>
    </a>
  );
}
