import { useEffect, useState } from "react";
import { type Conversation, deleteConversation, fetchConversations } from "../lib/api";

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

  const refresh = () => {
    fetchConversations(name)
      .then(setConversations)
      .catch(() => {});
  };

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleDelete = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    await deleteConversation(name, id);
    refresh();
    if (activeId === id) onNew();
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
          margin: "0 8px 8px",
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
    </div>
  );
}
