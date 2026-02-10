import { useCallback, useEffect, useState } from "react";
import { fetchHistory, type HistoryMessage } from "../lib/api";
import { renderMarkdown } from "../lib/marked";

const PAGE_SIZE = 50;

const selectStyle: React.CSSProperties = {
  background: "var(--bg-2)",
  color: "var(--text-0)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius)",
  padding: "4px 8px",
  fontSize: 12,
  fontFamily: "var(--mono)",
};

export function History({ name }: { name: string }) {
  const [messages, setMessages] = useState<HistoryMessage[]>([]);
  const [channel, setChannel] = useState("");
  const [role, setRole] = useState("");
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);

  const load = useCallback(
    async (offset: number) => {
      setLoading(true);
      try {
        const rows = await fetchHistory(name, {
          channel: channel || undefined,
          limit: PAGE_SIZE,
          offset,
        });
        if (offset === 0) {
          setMessages(rows);
        } else {
          setMessages((prev) => [...prev, ...rows]);
        }
        setHasMore(rows.length === PAGE_SIZE);
      } catch {
        // ignore
      }
      setLoading(false);
    },
    [name, channel],
  );

  useEffect(() => {
    load(0);
  }, [load]);

  const filtered = role ? messages.filter((m) => m.role === role) : messages;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      {/* Filters */}
      <div
        style={{
          display: "flex",
          gap: 12,
          padding: "0 0 12px",
          borderBottom: "1px solid var(--border)",
          flexShrink: 0,
        }}
      >
        <select value={channel} onChange={(e) => setChannel(e.target.value)} style={selectStyle}>
          <option value="">all channels</option>
          <option value="web">web</option>
          <option value="cli">cli</option>
          <option value="system:webhook">webhook</option>
          <option value="system:schedule">schedule</option>
        </select>
        <select value={role} onChange={(e) => setRole(e.target.value)} style={selectStyle}>
          <option value="">all roles</option>
          <option value="user">user</option>
          <option value="assistant">assistant</option>
        </select>
      </div>

      {/* Messages */}
      <div style={{ flex: 1, overflow: "auto", paddingTop: 12 }}>
        {filtered.length === 0 && !loading && (
          <div style={{ color: "var(--text-2)", textAlign: "center", padding: 40, fontSize: 13 }}>
            No messages found.
          </div>
        )}
        {filtered.map((msg) => (
          <HistoryEntry key={msg.id} msg={msg} />
        ))}
        {hasMore && (
          <div style={{ padding: "16px 0", textAlign: "center" }}>
            <button
              onClick={() => load(messages.length)}
              disabled={loading}
              style={{
                padding: "6px 16px",
                background: "var(--bg-3)",
                color: "var(--text-1)",
                borderRadius: "var(--radius)",
                fontSize: 12,
                opacity: loading ? 0.5 : 1,
              }}
            >
              {loading ? "loading..." : "load more"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function HistoryEntry({ msg }: { msg: HistoryMessage }) {
  const isUser = msg.role === "user";
  const date = new Date(msg.created_at);
  const time = date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <div style={{ marginBottom: 16, animation: "fadeIn 0.2s ease both" }}>
      <div style={{ display: "flex", gap: 10 }}>
        <span
          style={{
            color: isUser ? "var(--blue)" : "var(--accent)",
            fontSize: 11,
            fontWeight: 600,
            flexShrink: 0,
            marginTop: 2,
            textTransform: "uppercase",
          }}
        >
          {isUser ? (msg.sender ?? "user") : "agent"}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          {isUser ? (
            <div style={{ color: "var(--text-0)", whiteSpace: "pre-wrap" }}>{msg.content}</div>
          ) : (
            <div
              className="markdown-body"
              // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized by DOMPurify
              dangerouslySetInnerHTML={{
                __html: renderMarkdown(msg.content),
              }}
            />
          )}
        </div>
        <div
          style={{
            flexShrink: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "flex-end",
            gap: 2,
          }}
        >
          <span style={{ fontSize: 10, color: "var(--text-2)" }}>{time}</span>
          <span
            style={{
              fontSize: 10,
              color: "var(--text-2)",
              background: "var(--bg-3)",
              padding: "1px 6px",
              borderRadius: "var(--radius)",
            }}
          >
            {msg.channel}
          </span>
        </div>
      </div>
    </div>
  );
}
