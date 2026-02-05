import { useState, useEffect } from "react";
import { fetchAgents, type Agent } from "../lib/api";
import { AgentCard } from "../components/AgentCard";

export function Dashboard() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    const poll = async () => {
      try {
        const data = await fetchAgents();
        if (active) {
          setAgents(data);
          setError("");
        }
      } catch {
        if (active) setError("Failed to connect to API");
      }
    };

    poll();
    const interval = setInterval(poll, 5000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, []);

  if (error) {
    return (
      <div style={{ color: "var(--red)", padding: 40, textAlign: "center" }}>
        {error}
      </div>
    );
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
        <code style={{ color: "var(--text-1)" }}>molt create &lt;name&gt;</code>
      </div>
    );
  }

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
        gap: 16,
        maxWidth: 1200,
      }}
    >
      {agents.map((agent, i) => (
        <div key={agent.name} style={{ animationDelay: `${i * 50}ms` }}>
          <AgentCard agent={agent} />
        </div>
      ))}
    </div>
  );
}
