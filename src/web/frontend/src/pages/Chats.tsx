import { useCallback, useEffect, useState } from "react";
import { Chat } from "../components/Chat";
import {
  type Agent,
  type AvailableUser,
  type Conversation,
  createConversationWithParticipants,
  deleteConversationById,
  fetchAgents,
  fetchAllConversations,
  fetchAvailableUsers,
  type Participant,
} from "../lib/api";

type ConversationWithParticipants = Conversation & { participants: Participant[] };

export function Chats({
  conversationId: initialId,
  username,
}: {
  conversationId?: string;
  username: string;
}) {
  const [conversations, setConversations] = useState<ConversationWithParticipants[]>([]);
  const [activeId, setActiveId] = useState<string | null>(initialId ?? null);
  const [showNewChat, setShowNewChat] = useState(false);
  const [showGroupModal, setShowGroupModal] = useState(false);
  const [newChatAgent, setNewChatAgent] = useState<string | null>(null);

  const activeConv = conversations.find((c) => c.id === activeId);
  const agentName = activeConv?.agent_name ?? "";

  const refresh = useCallback(() => {
    fetchAllConversations()
      .then(setConversations)
      .catch((err: unknown) => console.warn("[chats] refresh failed:", err));
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 5000);
    return () => clearInterval(interval);
  }, [refresh]);

  // Sync hash with active conversation
  useEffect(() => {
    if (activeId) {
      const expected = `#/chats/${activeId}`;
      if (window.location.hash !== expected) {
        window.history.replaceState(null, "", expected);
      }
    }
  }, [activeId]);

  const handleSelect = (conv: ConversationWithParticipants) => {
    setActiveId(conv.id);
  };

  const handleNew = () => {
    setActiveId(null);
    window.history.replaceState(null, "", "#/chats");
  };

  const handleDelete = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    try {
      await deleteConversationById(id);
      refresh();
      if (activeId === id) handleNew();
    } catch (err) {
      console.warn("[chats] delete failed:", err);
    }
  };

  const handleConversationId = (id: string) => {
    setActiveId(id);
    refresh();
  };

  const handleNewChatCreated = (agent: string) => {
    setShowNewChat(false);
    setActiveId(null);
    setNewChatAgent(agent);
  };

  // Clear newChatAgent only once the conversation list has caught up
  useEffect(() => {
    if (activeId && activeConv) setNewChatAgent(null);
  }, [activeId, activeConv]);

  const handleGroupCreated = (conv: Conversation) => {
    setShowGroupModal(false);
    refresh();
    setActiveId(conv.id);
  };

  // The agent name to use for the Chat component: from active conversation or new chat pick
  const chatAgentName = newChatAgent || agentName;

  function getConversationLabel(conv: ConversationWithParticipants): string {
    if (conv.title) return conv.title;
    const agents = conv.participants?.filter((p) => p.userType === "agent") ?? [];
    if (agents.length > 0) return agents.map((a) => a.username).join(", ");
    return "Untitled";
  }

  function getParticipantBadges(conv: ConversationWithParticipants): Participant[] {
    return conv.participants?.filter((p) => p.userType === "agent") ?? [];
  }

  return (
    <div
      style={{
        display: "flex",
        height: "calc(100vh - 48px - 48px)",
        animation: "fadeIn 0.2s ease both",
      }}
    >
      {/* Sidebar */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          width: 240,
          flexShrink: 0,
          borderRight: "1px solid var(--border)",
        }}
      >
        <div style={{ display: "flex", gap: 4, padding: "0 8px 8px" }}>
          <button
            onClick={() => setShowNewChat(true)}
            style={{
              flex: 1,
              padding: "8px 12px",
              background: "var(--accent-dim)",
              color: "var(--accent)",
              borderRadius: "var(--radius)",
              fontSize: 12,
              fontWeight: 500,
              textAlign: "left" as const,
            }}
          >
            + new chat
          </button>
          <button
            onClick={() => setShowGroupModal(true)}
            style={{
              padding: "8px 10px",
              background: "var(--bg-2)",
              color: "var(--text-1)",
              borderRadius: "var(--radius)",
              fontSize: 12,
              border: "1px solid var(--border)",
            }}
            title="New group"
          >
            ++
          </button>
        </div>
        <div style={{ flex: 1, overflow: "auto" }}>
          {conversations.map((conv) => {
            const badges = getParticipantBadges(conv);
            return (
              <div
                key={conv.id}
                onClick={() => handleSelect(conv)}
                style={{
                  padding: "8px 12px",
                  margin: "0 4px",
                  cursor: "pointer",
                  borderRadius: "var(--radius)",
                  background: conv.id === activeId ? "var(--bg-3)" : "transparent",
                  display: "flex",
                  flexDirection: "column",
                  gap: 2,
                  transition: "background 0.1s",
                }}
                onMouseEnter={(e) => {
                  if (conv.id !== activeId) e.currentTarget.style.background = "var(--bg-2)";
                }}
                onMouseLeave={(e) => {
                  if (conv.id !== activeId) e.currentTarget.style.background = "transparent";
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 4,
                  }}
                >
                  <div
                    style={{
                      flex: 1,
                      minWidth: 0,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      fontSize: 12,
                      color: conv.id === activeId ? "var(--text-0)" : "var(--text-1)",
                    }}
                  >
                    {getConversationLabel(conv)}
                  </div>
                  <button
                    onClick={(e) => handleDelete(e, conv.id)}
                    style={{
                      background: "transparent",
                      color: "var(--text-2)",
                      fontSize: 11,
                      padding: "0 4px",
                      flexShrink: 0,
                      visibility: conv.id === activeId ? "visible" : "hidden",
                    }}
                  >
                    x
                  </button>
                </div>
                {badges.length > 0 && (
                  <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                    {badges.map((p) => (
                      <span
                        key={p.userId}
                        style={{
                          fontSize: 10,
                          color: "var(--accent)",
                          background: "var(--accent-bg)",
                          padding: "1px 5px",
                          borderRadius: 3,
                        }}
                      >
                        {p.username}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          {conversations.length === 0 && (
            <div
              style={{
                color: "var(--text-2)",
                fontSize: 12,
                padding: "16px 12px",
                textAlign: "center",
              }}
            >
              No conversations yet
            </div>
          )}
        </div>
      </div>

      {/* Chat panel */}
      <div style={{ flex: 1, paddingLeft: 16, minWidth: 0 }}>
        {chatAgentName ? (
          <Chat
            name={chatAgentName}
            username={username}
            conversationId={activeId}
            onConversationId={handleConversationId}
          />
        ) : (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              height: "100%",
              color: "var(--text-2)",
              fontSize: 13,
            }}
          >
            Select a conversation or start a new chat
          </div>
        )}
      </div>

      {showNewChat && (
        <AgentPickerModal onClose={() => setShowNewChat(false)} onPick={handleNewChatCreated} />
      )}
      {showGroupModal && (
        <GroupModal onClose={() => setShowGroupModal(false)} onCreated={handleGroupCreated} />
      )}
    </div>
  );
}

function AgentPickerModal({
  onClose,
  onPick,
}: {
  onClose: () => void;
  onPick: (agentName: string) => void;
}) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    fetchAgents()
      .then((a) => {
        setAgents(a);
        setLoading(false);
      })
      .catch(() => {
        setLoading(false);
        setError("Failed to load agents");
      });
  }, []);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 100,
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: "var(--bg-1)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-lg)",
          padding: 20,
          width: 280,
          maxHeight: "50vh",
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ fontWeight: 600, color: "var(--text-0)", fontSize: 14 }}>
          New chat with...
        </div>
        {loading ? (
          <div style={{ color: "var(--text-2)", fontSize: 12 }}>Loading agents...</div>
        ) : error ? (
          <div style={{ color: "var(--red)", fontSize: 12, padding: 8 }}>{error}</div>
        ) : (
          <div style={{ flex: 1, overflow: "auto" }}>
            {agents.map((a) => (
              <button
                key={a.name}
                onClick={() => onPick(a.name)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  width: "100%",
                  padding: "8px 10px",
                  background: "transparent",
                  color: "var(--text-0)",
                  fontSize: 13,
                  borderRadius: "var(--radius)",
                  textAlign: "left",
                  transition: "background 0.1s",
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-2)")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
              >
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    background: a.status === "running" ? "var(--accent)" : "var(--text-2)",
                    flexShrink: 0,
                  }}
                />
                {a.name}
              </button>
            ))}
            {agents.length === 0 && (
              <div style={{ color: "var(--text-2)", fontSize: 12, padding: 8 }}>
                No agents found
              </div>
            )}
          </div>
        )}
        <button
          onClick={onClose}
          style={{
            padding: "6px 14px",
            background: "var(--bg-2)",
            color: "var(--text-1)",
            borderRadius: "var(--radius)",
            fontSize: 12,
            border: "1px solid var(--border)",
            alignSelf: "flex-end",
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function GroupModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (conv: Conversation) => void;
}) {
  const [users, setUsers] = useState<AvailableUser[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [title, setTitle] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    fetchAvailableUsers()
      .then(setUsers)
      .catch(() => setError("Failed to load users"));
  }, []);

  const toggle = (username: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(username)) next.delete(username);
      else next.add(username);
      return next;
    });
  };

  const hasAgent = users.some((u) => u.user_type === "agent" && selected.has(u.username));

  const handleCreate = async () => {
    if (!hasAgent) {
      setError("Select at least one agent");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const conv = await createConversationWithParticipants([...selected], title || undefined);
      onCreated(conv);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create");
      setLoading(false);
    }
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 100,
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: "var(--bg-1)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-lg)",
          padding: 20,
          width: 340,
          maxHeight: "70vh",
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ fontWeight: 600, color: "var(--text-0)", fontSize: 14 }}>
          New group conversation
        </div>

        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Title (optional)"
          style={{
            background: "var(--bg-2)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            padding: "8px 10px",
            color: "var(--text-0)",
            fontSize: 12,
            outline: "none",
            fontFamily: "var(--mono)",
          }}
        />

        <div style={{ color: "var(--text-2)", fontSize: 11 }}>
          Select participants (at least one agent):
        </div>
        <div style={{ flex: 1, overflow: "auto", maxHeight: 250 }}>
          {users.map((u) => (
            <label
              key={u.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "6px 4px",
                cursor: "pointer",
                fontSize: 12,
                color: "var(--text-0)",
              }}
            >
              <input
                type="checkbox"
                checked={selected.has(u.username)}
                onChange={() => toggle(u.username)}
              />
              <span>{u.username}</span>
              <span
                style={{
                  color: u.user_type === "agent" ? "var(--accent)" : "var(--text-2)",
                  fontSize: 10,
                  marginLeft: "auto",
                }}
              >
                {u.user_type}
              </span>
            </label>
          ))}
        </div>

        {error && <div style={{ color: "var(--red)", fontSize: 11 }}>{error}</div>}

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button
            onClick={onClose}
            style={{
              padding: "6px 14px",
              background: "var(--bg-2)",
              color: "var(--text-1)",
              borderRadius: "var(--radius)",
              fontSize: 12,
              border: "1px solid var(--border)",
            }}
          >
            Cancel
          </button>
          <button
            onClick={handleCreate}
            disabled={loading || !hasAgent}
            style={{
              padding: "6px 14px",
              background: "var(--accent-dim)",
              color: "var(--accent)",
              borderRadius: "var(--radius)",
              fontSize: 12,
              fontWeight: 500,
              opacity: loading || !hasAgent ? 0.5 : 1,
            }}
          >
            {loading ? "Creating..." : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}
