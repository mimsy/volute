import { useState, useRef, useEffect, useCallback } from "react";
import { useChatStream } from "../lib/useStream";
import type { MoltEvent } from "../lib/api";

type ChatEntry =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; tools: ToolBlock[] };

type ToolBlock = {
  name: string;
  input: unknown;
  output?: string;
  isError?: boolean;
};

export function Chat({ name }: { name: string }) {
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Track current assistant entry being built
  const currentRef = useRef<{ text: string; tools: ToolBlock[] }>({
    text: "",
    tools: [],
  });

  const onEvent = useCallback((event: MoltEvent) => {
    const cur = currentRef.current;

    if (event.type === "text") {
      cur.text += event.content;
      setEntries((prev) => {
        const next = [...prev];
        next[next.length - 1] = {
          role: "assistant",
          text: cur.text,
          tools: [...cur.tools],
        };
        return next;
      });
    } else if (event.type === "tool_use") {
      cur.tools.push({ name: event.name, input: event.input });
      setEntries((prev) => {
        const next = [...prev];
        next[next.length - 1] = {
          role: "assistant",
          text: cur.text,
          tools: [...cur.tools],
        };
        return next;
      });
    } else if (event.type === "tool_result") {
      const last = cur.tools[cur.tools.length - 1];
      if (last) {
        last.output = event.output;
        last.isError = event.is_error;
      }
      setEntries((prev) => {
        const next = [...prev];
        next[next.length - 1] = {
          role: "assistant",
          text: cur.text,
          tools: [...cur.tools],
        };
        return next;
      });
    } else if (event.type === "done") {
      setStreaming(false);
    }
  }, []);

  const { send, stop } = useChatStream(name, onEvent);

  // Auto-scroll on new content
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const isNearBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight < 100;
    if (isNearBottom) {
      el.scrollTop = el.scrollHeight;
    }
  }, [entries]);

  const handleSend = async () => {
    const message = input.trim();
    if (!message || streaming) return;

    setInput("");
    currentRef.current = { text: "", tools: [] };
    setEntries((prev) => [
      ...prev,
      { role: "user", text: message },
      { role: "assistant", text: "", tools: [] },
    ]);
    setStreaming(true);

    try {
      await send(message);
    } catch {
      setStreaming(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
      }}
    >
      {/* Messages */}
      <div
        ref={scrollRef}
        style={{
          flex: 1,
          overflow: "auto",
          padding: "16px 0",
        }}
      >
        {entries.length === 0 && (
          <div
            style={{
              color: "var(--text-2)",
              textAlign: "center",
              padding: 40,
              fontSize: 13,
            }}
          >
            Send a message to start chatting.
          </div>
        )}
        {entries.map((entry, i) => (
          <div
            key={i}
            style={{
              marginBottom: 16,
              animation: "fadeIn 0.2s ease both",
            }}
          >
            {entry.role === "user" ? (
              <div style={{ display: "flex", gap: 10 }}>
                <span
                  style={{
                    color: "var(--blue)",
                    fontSize: 11,
                    fontWeight: 600,
                    flexShrink: 0,
                    marginTop: 2,
                    textTransform: "uppercase",
                  }}
                >
                  you
                </span>
                <div style={{ color: "var(--text-0)", whiteSpace: "pre-wrap" }}>
                  {entry.text}
                </div>
              </div>
            ) : (
              <div style={{ display: "flex", gap: 10 }}>
                <span
                  style={{
                    color: "var(--accent)",
                    fontSize: 11,
                    fontWeight: 600,
                    flexShrink: 0,
                    marginTop: 2,
                    textTransform: "uppercase",
                  }}
                >
                  agent
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  {entry.tools.map((tool, j) => (
                    <ToolUseBlock key={j} tool={tool} />
                  ))}
                  {entry.text && (
                    <div
                      style={{
                        color: "var(--text-0)",
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word",
                      }}
                    >
                      {entry.text}
                      {streaming && i === entries.length - 1 && (
                        <span
                          style={{
                            display: "inline-block",
                            width: 7,
                            height: 14,
                            background: "var(--accent)",
                            marginLeft: 2,
                            animation: "pulse 0.8s ease infinite",
                            verticalAlign: "text-bottom",
                          }}
                        />
                      )}
                    </div>
                  )}
                  {!entry.text &&
                    streaming &&
                    i === entries.length - 1 &&
                    entry.tools.length === 0 && (
                      <span
                        style={{
                          color: "var(--text-2)",
                          animation: "pulse 1.5s ease infinite",
                        }}
                      >
                        thinking...
                      </span>
                    )}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Input */}
      <div
        style={{
          borderTop: "1px solid var(--border)",
          padding: "12px 0 0",
          display: "flex",
          gap: 8,
        }}
      >
        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Send a message..."
          rows={1}
          style={{
            flex: 1,
            background: "var(--bg-2)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            padding: "10px 12px",
            color: "var(--text-0)",
            fontFamily: "var(--mono)",
            fontSize: 13,
            resize: "none",
            outline: "none",
            transition: "border-color 0.15s",
          }}
          onFocus={(e) =>
            (e.currentTarget.style.borderColor = "var(--border-bright)")
          }
          onBlur={(e) =>
            (e.currentTarget.style.borderColor = "var(--border)")
          }
        />
        {streaming ? (
          <button
            onClick={stop}
            style={{
              padding: "0 16px",
              background: "var(--red-dim)",
              color: "var(--red)",
              borderRadius: "var(--radius)",
              fontSize: 12,
              fontWeight: 500,
            }}
          >
            stop
          </button>
        ) : (
          <button
            onClick={handleSend}
            disabled={!input.trim()}
            style={{
              padding: "0 16px",
              background: input.trim()
                ? "var(--accent-dim)"
                : "var(--bg-3)",
              color: input.trim() ? "var(--accent)" : "var(--text-2)",
              borderRadius: "var(--radius)",
              fontSize: 12,
              fontWeight: 500,
              transition: "all 0.15s",
            }}
          >
            send
          </button>
        )}
      </div>
    </div>
  );
}

function ToolUseBlock({ tool }: { tool: ToolBlock }) {
  const [open, setOpen] = useState(false);

  return (
    <div
      style={{
        marginBottom: 8,
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)",
        overflow: "hidden",
        fontSize: 12,
      }}
    >
      <button
        onClick={() => setOpen(!open)}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "6px 10px",
          background: "var(--bg-3)",
          color: "var(--purple)",
          fontSize: 12,
          fontFamily: "var(--mono)",
          textAlign: "left",
        }}
      >
        <span>
          <span style={{ color: "var(--text-2)", marginRight: 6 }}>
            {open ? "v" : ">"}
          </span>
          {tool.name}
        </span>
        {tool.output !== undefined && (
          <span
            style={{
              color: tool.isError ? "var(--red)" : "var(--accent)",
              fontSize: 10,
            }}
          >
            {tool.isError ? "error" : "done"}
          </span>
        )}
      </button>
      {open && (
        <div style={{ padding: 10, background: "var(--bg-1)" }}>
          <div style={{ marginBottom: 6, color: "var(--text-2)" }}>input:</div>
          <pre
            style={{
              color: "var(--text-1)",
              whiteSpace: "pre-wrap",
              wordBreak: "break-all",
              fontSize: 11,
              lineHeight: 1.5,
            }}
          >
            {JSON.stringify(tool.input, null, 2)}
          </pre>
          {tool.output !== undefined && (
            <>
              <div
                style={{
                  marginTop: 8,
                  marginBottom: 6,
                  color: "var(--text-2)",
                }}
              >
                output:
              </div>
              <pre
                style={{
                  color: tool.isError ? "var(--red)" : "var(--text-1)",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-all",
                  fontSize: 11,
                  lineHeight: 1.5,
                  maxHeight: 200,
                  overflow: "auto",
                }}
              >
                {tool.output}
              </pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}
