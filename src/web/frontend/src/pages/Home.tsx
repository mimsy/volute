import { useEffect, useState } from "react";
import { StatusBadge } from "../components/StatusBadge";
import {
  type Agent,
  type Conversation,
  fetchAgents,
  fetchAllConversations,
  type LastMessageSummary,
  type Participant,
} from "../lib/api";

type ConversationWithDetails = Conversation & {
  participants: Participant[];
  lastMessage?: LastMessageSummary;
};

function getConversationLabel(conv: ConversationWithDetails, username: string): string {
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
  const [conversations, setConversations] = useState<ConversationWithDetails[]>([]);

  useEffect(() => {
    fetchAgents()
      .then(setAgents)
      .catch(() => {});
    fetchAllConversations()
      .then(setConversations)
      .catch(() => {});
  }, []);

  // Sort agents: running first, then by most recent activity
  const sortedAgents = [...agents].sort((a, b) => {
    if (a.status === "running" && b.status !== "running") return -1;
    if (a.status !== "running" && b.status === "running") return 1;
    const aTime = a.lastActiveAt ?? "";
    const bTime = b.lastActiveAt ?? "";
    return bTime.localeCompare(aTime);
  });

  const recentConversations = [...conversations]
    .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
    .slice(0, 5);

  return (
    <div style={{ maxWidth: 800, animation: "fadeIn 0.2s ease both" }}>
      {/* Agents */}
      <Section title="agents" href="#/agents" linkLabel="all agents">
        {agents.length === 0 ? (
          <div style={{ color: "var(--text-2)", fontSize: 12 }}>
            No agents registered. Run{" "}
            <code style={{ color: "var(--text-1)" }}>volute agent create &lt;name&gt;</code> to get
            started.
          </div>
        ) : (
          <div style={{ display: "flex", gap: 10, overflowX: "auto", paddingBottom: 4 }}>
            {sortedAgents.map((a) => (
              <AgentCard key={a.name} agent={a} />
            ))}
          </div>
        )}
      </Section>

      {/* Recent conversations */}
      {recentConversations.length > 0 && (
        <Section title="recent conversations" href="#/chats" linkLabel="open chat">
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {recentConversations.map((conv) => (
              <ConversationCard key={conv.id} conv={conv} username={username} agents={agents} />
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}

function Section({
  title,
  href,
  linkLabel,
  children,
}: {
  title: string;
  href?: string;
  linkLabel?: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ marginBottom: 24 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          marginBottom: 8,
        }}
      >
        <span style={{ color: "var(--text-2)" }}>{title}</span>
        {href && linkLabel && (
          <a
            href={href}
            style={{ color: "var(--text-2)", fontSize: 10, textTransform: "none" }}
            onMouseEnter={(e) => (e.currentTarget.style.color = "var(--text-1)")}
            onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-2)")}
          >
            {linkLabel} &rarr;
          </a>
        )}
      </div>
      {children}
    </div>
  );
}

function getDisplayStatus(agent: Agent): string {
  if (agent.status !== "running") return agent.status;
  if (!agent.lastActiveAt) return "running";
  const ago = Date.now() - new Date(`${agent.lastActiveAt}Z`).getTime();
  return ago < 5 * 60_000 ? "active" : "running";
}

function AgentCard({ agent }: { agent: Agent }) {
  const channels = agent.channels.filter(
    (ch) => ch.name !== "web" && ch.name !== "volute" && ch.status === "connected",
  );

  return (
    <a
      href={`#/agent/${agent.name}`}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 6,
        padding: "10px 14px",
        borderRadius: "var(--radius-lg)",
        background: "var(--bg-2)",
        border: "1px solid var(--border)",
        minWidth: 150,
        transition: "border-color 0.15s",
        flexShrink: 0,
      }}
      onMouseEnter={(e) => (e.currentTarget.style.borderColor = "var(--border-bright)")}
      onMouseLeave={(e) => (e.currentTarget.style.borderColor = "var(--border)")}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ color: "var(--text-0)", fontWeight: 500, fontSize: 13 }}>{agent.name}</span>
        <StatusBadge status={getDisplayStatus(agent)} />
        {agent.stage === "seed" && (
          <span style={{ fontSize: 9, color: "var(--yellow)" }}>seed</span>
        )}
      </div>
      {channels.length > 0 && (
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          {channels.map((ch) => (
            <span
              key={ch.name}
              style={{
                fontSize: 10,
                padding: "1px 5px",
                borderRadius: 3,
                background: "var(--accent-dim)",
                color: "var(--accent)",
              }}
            >
              {ch.displayName || ch.name}
            </span>
          ))}
        </div>
      )}
      <div style={{ fontSize: 10, color: "var(--text-2)" }}>
        {agent.lastActiveAt ? `active ${formatRelativeTime(agent.lastActiveAt)}` : "no activity"}
      </div>
    </a>
  );
}

function ConversationCard({
  conv,
  username,
  agents,
}: {
  conv: ConversationWithDetails;
  username: string;
  agents: Agent[];
}) {
  const label = getConversationLabel(conv, username);
  const isSeed = agents.find((a) => a.name === conv.agent_name)?.stage === "seed";
  const msg = conv.lastMessage;

  let preview = "";
  if (msg) {
    const sender = msg.senderName ? `${msg.senderName}: ` : "";
    preview = sender + msg.text;
  }

  return (
    <a
      href={`#/chats/${conv.id}`}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "10px 14px",
        borderRadius: "var(--radius-lg)",
        background: "var(--bg-2)",
        border: "1px solid var(--border)",
        transition: "border-color 0.15s",
      }}
      onMouseEnter={(e) => (e.currentTarget.style.borderColor = "var(--border-bright)")}
      onMouseLeave={(e) => (e.currentTarget.style.borderColor = "var(--border)")}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
          <span style={{ color: "var(--text-0)", fontWeight: 500, fontSize: 12 }}>{label}</span>
          {isSeed && <span style={{ fontSize: 9, color: "var(--yellow)" }}>seed</span>}
        </div>
        {preview && (
          <div
            style={{
              fontSize: 11,
              color: "var(--text-2)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {preview}
          </div>
        )}
      </div>
      <span style={{ color: "var(--text-2)", fontSize: 10, flexShrink: 0 }}>
        {formatRelativeTime(conv.updated_at)}
      </span>
    </a>
  );
}

function formatRelativeTime(dateStr: string): string {
  const now = Date.now();
  // SQLite datetime('now') stores UTC without Z suffix; ensure UTC parsing
  const normalized = dateStr.endsWith("Z") ? dateStr : `${dateStr}Z`;
  const then = new Date(normalized).getTime();
  const diff = now - then;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
