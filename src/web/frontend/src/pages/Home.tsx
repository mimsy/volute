import { useEffect, useState } from "react";
import { StatusBadge } from "../components/StatusBadge";
import {
  type Agent,
  type Conversation,
  fetchAgents,
  fetchAllConversations,
  type Participant,
} from "../lib/api";

type ConversationWithParticipants = Conversation & { participants: Participant[] };

function getConversationLabel(conv: ConversationWithParticipants, username: string): string {
  const participants = conv.participants ?? [];
  if (participants.length === 2) {
    const other = participants.find((p) => p.username !== username);
    if (other) return `@${other.username}`;
  }
  if (conv.title) return conv.title;
  const agents = participants.filter((p) => p.userType === "agent");
  if (agents.length > 0) return agents.map((a) => a.username).join(", ");
  return "Untitled";
}

export function Home({ username }: { username: string }) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [conversations, setConversations] = useState<ConversationWithParticipants[]>([]);

  useEffect(() => {
    fetchAgents()
      .then(setAgents)
      .catch(() => {});
    fetchAllConversations()
      .then(setConversations)
      .catch(() => {});
  }, []);

  const running = agents.filter((a) => a.status === "running");
  const stopped = agents.filter((a) => a.status !== "running");
  const recentConversations = [...conversations]
    .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
    .slice(0, 5);

  const connectedChannels = agents.flatMap((a) =>
    a.channels
      .filter((ch) => ch.name !== "web" && ch.status === "connected")
      .map((ch) => ({ agent: a.name, channel: ch })),
  );

  return (
    <div style={{ maxWidth: 720, animation: "fadeIn 0.2s ease both" }}>
      {/* Quick links */}
      <div style={{ display: "flex", gap: 8, marginBottom: 24 }}>
        <a
          href="#/chats"
          style={{
            padding: "8px 16px",
            background: "var(--accent-dim)",
            color: "var(--accent)",
            borderRadius: "var(--radius)",
            fontSize: 12,
            fontWeight: 500,
          }}
        >
          open chat
        </a>
        <a
          href="#/agents"
          style={{
            padding: "8px 16px",
            background: "var(--bg-2)",
            color: "var(--text-1)",
            borderRadius: "var(--radius)",
            fontSize: 12,
            border: "1px solid var(--border)",
          }}
        >
          all agents
        </a>
      </div>

      {/* Agents overview */}
      <Section title="agents">
        {agents.length === 0 ? (
          <div style={{ color: "var(--text-2)", fontSize: 12 }}>
            No agents registered. Run{" "}
            <code style={{ color: "var(--text-1)" }}>volute agent create &lt;name&gt;</code> to get
            started.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {running.map((a) => (
              <AgentRow key={a.name} agent={a} />
            ))}
            {stopped.map((a) => (
              <AgentRow key={a.name} agent={a} />
            ))}
          </div>
        )}
      </Section>

      {/* Recent conversations */}
      {recentConversations.length > 0 && (
        <Section title="recent conversations">
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {recentConversations.map((conv) => {
              const isSeed = agents.find((a) => a.name === conv.agent_name)?.stage === "seed";
              return (
                <a
                  key={conv.id}
                  href={`#/chats/${conv.id}`}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "6px 8px",
                    borderRadius: "var(--radius)",
                    fontSize: 12,
                    transition: "background 0.1s",
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-2)")}
                  onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                >
                  <span
                    style={{
                      color: "var(--text-0)",
                      flex: 1,
                      minWidth: 0,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {getConversationLabel(conv, username)}
                  </span>
                  {isSeed && (
                    <span style={{ fontSize: 9, color: "var(--yellow)", flexShrink: 0 }}>seed</span>
                  )}
                  <span style={{ color: "var(--text-2)", fontSize: 10, flexShrink: 0 }}>
                    {formatRelativeTime(conv.updated_at)}
                  </span>
                </a>
              );
            })}
          </div>
        </Section>
      )}

      {/* Connected channels */}
      {connectedChannels.length > 0 && (
        <Section title="connected channels">
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {connectedChannels.map(({ agent, channel }) => (
              <span
                key={`${agent}-${channel.name}`}
                style={{
                  fontSize: 11,
                  padding: "3px 8px",
                  borderRadius: "var(--radius)",
                  background: "var(--accent-dim)",
                  color: "var(--accent)",
                }}
              >
                {agent}/{channel.displayName || channel.name}
              </span>
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 24 }}>
      <div
        style={{
          fontSize: 11,
          color: "var(--text-2)",
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          marginBottom: 8,
        }}
      >
        {title}
      </div>
      {children}
    </div>
  );
}

function AgentRow({ agent }: { agent: Agent }) {
  return (
    <a
      href={`#/agent/${agent.name}`}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 8px",
        borderRadius: "var(--radius)",
        fontSize: 12,
        transition: "background 0.1s",
      }}
      onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-2)")}
      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
    >
      <span style={{ color: "var(--text-0)", fontWeight: 500 }}>{agent.name}</span>
      <StatusBadge status={agent.status} />
      {agent.stage === "seed" && <span style={{ fontSize: 9, color: "var(--yellow)" }}>seed</span>}
      <span style={{ color: "var(--text-2)", fontSize: 11, marginLeft: "auto" }}>
        :{agent.port}
      </span>
    </a>
  );
}

function formatRelativeTime(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diff = now - then;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
