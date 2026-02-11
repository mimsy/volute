import { useCallback, useEffect, useState } from "react";
import {
  type AvailableUser,
  type Conversation,
  createGroupConversation,
  deleteConversation,
  fetchAvailableUsers,
  fetchConversations,
} from "../lib/api";

export function ConversationList({
  name,
  activeId,
  onSelect,
  onNew,
}: {
  name: string;
  activeId: string | null;
  onSelect: (conv: Conversation) => void;
  onNew: () => void;
}) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [showGroupModal, setShowGroupModal] = useState(false);

  const refresh = useCallback(() => {
    fetchConversations(name)
      .then(setConversations)
      .catch(() => {});
  }, [name]);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 5000);
    return () => clearInterval(interval);
  }, [refresh]);

  const handleDelete = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    await deleteConversation(name, id);
    refresh();
    if (activeId === id) onNew();
  };

  const handleGroupCreated = (conv: Conversation) => {
    setShowGroupModal(false);
    refresh();
    onSelect(conv);
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        borderRight: "1px solid var(--border)",
        width: 220,
        flexShrink: 0,
      }}
    >
      <button
        onClick={onNew}
        style={{
          padding: "8px 12px",
          margin: "0 8px 4px",
          background: "var(--accent-dim)",
          color: "var(--accent)",
          borderRadius: "var(--radius)",
          fontSize: 12,
          fontWeight: 500,
          textAlign: "left" as const,
        }}
      >
        + new conversation
      </button>
      <button
        onClick={() => setShowGroupModal(true)}
        style={{
          padding: "8px 12px",
          margin: "0 8px 8px",
          background: "var(--bg-2)",
          color: "var(--text-1)",
          borderRadius: "var(--radius)",
          fontSize: 12,
          fontWeight: 500,
          textAlign: "left" as const,
          border: "1px solid var(--border)",
        }}
      >
        + new group
      </button>
      <div style={{ flex: 1, overflow: "auto" }}>
        {conversations.map((conv) => (
          <div
            key={conv.id}
            onClick={() => onSelect(conv)}
            style={{
              padding: "8px 12px",
              margin: "0 4px",
              cursor: "pointer",
              borderRadius: "var(--radius)",
              background: conv.id === activeId ? "var(--bg-3)" : "transparent",
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
              {conv.title || "Untitled"}
              {conv.participants && conv.participants.length > 2 && (
                <span style={{ color: "var(--text-2)", fontSize: 10, marginLeft: 4 }}>
                  ({conv.participants.length})
                </span>
              )}
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
        ))}
      </div>
      {showGroupModal && (
        <GroupModal
          agentName={name}
          onClose={() => setShowGroupModal(false)}
          onCreated={handleGroupCreated}
        />
      )}
    </div>
  );
}

function GroupModal({
  agentName,
  onClose,
  onCreated,
}: {
  agentName: string;
  onClose: () => void;
  onCreated: (conv: Conversation) => void;
}) {
  const [users, setUsers] = useState<AvailableUser[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [title, setTitle] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    fetchAvailableUsers()
      .then((all) => {
        // Filter out the current agent (they're auto-added) and show the rest
        setUsers(all.filter((u) => u.username !== agentName));
      })
      .catch(() => setError("Failed to load users"));
  }, [agentName]);

  const toggle = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleCreate = async () => {
    setLoading(true);
    setError("");
    try {
      const conv = await createGroupConversation(agentName, [...selected], title || undefined);
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
          width: 320,
          maxHeight: "60vh",
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
          }}
        />

        <div style={{ color: "var(--text-2)", fontSize: 11 }}>
          Select participants (agent "{agentName}" auto-included):
        </div>

        <div style={{ flex: 1, overflow: "auto", maxHeight: 200 }}>
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
              <input type="checkbox" checked={selected.has(u.id)} onChange={() => toggle(u.id)} />
              <span>{u.username}</span>
              <span style={{ color: "var(--text-2)", fontSize: 10, marginLeft: "auto" }}>
                {u.user_type}
              </span>
            </label>
          ))}
          {users.length === 0 && !error && (
            <div style={{ color: "var(--text-2)", fontSize: 12, padding: 8 }}>No users found</div>
          )}
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
            disabled={loading}
            style={{
              padding: "6px 14px",
              background: "var(--accent-dim)",
              color: "var(--accent)",
              borderRadius: "var(--radius)",
              fontSize: 12,
              fontWeight: 500,
              opacity: loading ? 0.5 : 1,
            }}
          >
            {loading ? "Creating..." : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}
