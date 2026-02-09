import { Marked } from "marked";
import { useCallback, useEffect, useRef, useState } from "react";
import { type ContentBlock, fetchConversationMessages, type VoluteEvent } from "../lib/api";
import { useChatStream } from "../lib/useStream";

const marked = new Marked({ breaks: true, gfm: true });

type ChatEntry = { role: "user" | "assistant"; blocks: ContentBlock[] };

function normalizeContent(content: ContentBlock[] | string): ContentBlock[] {
  if (Array.isArray(content)) return content;
  return [{ type: "text", text: String(content) }];
}

type ToolBlock = {
  name: string;
  input: unknown;
  output?: string;
  isError?: boolean;
};

export function Chat({
  name,
  conversationId,
  onConversationId,
}: {
  name: string;
  conversationId: string | null;
  onConversationId: (id: string) => void;
}) {
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [pendingImages, setPendingImages] = useState<
    Array<{ media_type: string; data: string; preview: string }>
  >([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const convIdRef = useRef(conversationId);

  // Track current assistant blocks being built
  const currentRef = useRef<ContentBlock[]>([]);

  // Load existing messages when conversationId changes
  useEffect(() => {
    convIdRef.current = conversationId;
    if (!conversationId) {
      setEntries([]);
      return;
    }
    fetchConversationMessages(name, conversationId)
      .then((msgs) => {
        const loaded: ChatEntry[] = msgs.map((m) => ({
          role: m.role as "user" | "assistant",
          blocks: normalizeContent(m.content),
        }));
        setEntries(loaded);
      })
      .catch(() => {});
  }, [name, conversationId]);

  const onEvent = useCallback(
    (event: VoluteEvent) => {
      if (event.type === "meta") {
        convIdRef.current = event.conversationId;
        onConversationId(event.conversationId);
        return;
      }

      const blocks = currentRef.current;

      if (event.type === "text") {
        // Merge consecutive text blocks
        const last = blocks[blocks.length - 1];
        if (last && last.type === "text") {
          last.text += event.content;
        } else {
          blocks.push({ type: "text", text: event.content });
        }
      } else if (event.type === "tool_use") {
        blocks.push({ type: "tool_use", name: event.name, input: event.input });
      } else if (event.type === "tool_result") {
        blocks.push({
          type: "tool_result",
          output: event.output,
          ...(event.is_error ? { is_error: true } : {}),
        });
      } else if (event.type === "done") {
        setStreaming(false);
        return;
      }

      setEntries((prev) => {
        const next = [...prev];
        next[next.length - 1] = {
          role: "assistant",
          blocks: [...blocks],
        };
        return next;
      });
    },
    [onConversationId],
  );

  const { send, stop } = useChatStream(name, onEvent);

  // Auto-scroll on new content
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
    if (isNearBottom) {
      el.scrollTop = el.scrollHeight;
    }
  }, []);

  const handleSend = async () => {
    const message = input.trim();
    if (!message && pendingImages.length === 0) return;
    if (streaming) return;

    const images = pendingImages.map(({ media_type, data }) => ({
      media_type,
      data,
    }));

    // Build user blocks
    const userBlocks: ContentBlock[] = [];
    if (message) {
      userBlocks.push({ type: "text", text: message });
    }
    for (const img of pendingImages) {
      userBlocks.push({
        type: "image",
        media_type: img.media_type,
        data: img.data,
      });
    }

    setInput("");
    setPendingImages([]);
    currentRef.current = [];
    setEntries((prev) => [
      ...prev,
      { role: "user", blocks: userBlocks },
      { role: "assistant", blocks: [] },
    ]);
    setStreaming(true);

    try {
      await send(message, convIdRef.current ?? undefined, images.length > 0 ? images : undefined);
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

  const handleFiles = (files: FileList | null) => {
    if (!files) return;
    for (const file of Array.from(files)) {
      if (!file.type.startsWith("image/")) continue;
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        const base64 = result.split(",")[1];
        setPendingImages((prev) => [
          ...prev,
          { media_type: file.type, data: base64, preview: result },
        ]);
      };
      reader.readAsDataURL(file);
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
              <UserMessage blocks={entry.blocks} />
            ) : (
              <AssistantMessage
                blocks={entry.blocks}
                isStreaming={streaming && i === entries.length - 1}
              />
            )}
          </div>
        ))}
      </div>

      {/* Image preview strip */}
      {pendingImages.length > 0 && (
        <div
          style={{
            display: "flex",
            gap: 8,
            padding: "8px 0",
            borderTop: "1px solid var(--border)",
            overflowX: "auto",
          }}
        >
          {pendingImages.map((img, i) => (
            <div key={i} style={{ position: "relative", flexShrink: 0 }}>
              <img
                src={img.preview}
                alt=""
                style={{
                  height: 60,
                  borderRadius: "var(--radius)",
                  border: "1px solid var(--border)",
                }}
              />
              <button
                onClick={() => setPendingImages((prev) => prev.filter((_, j) => j !== i))}
                style={{
                  position: "absolute",
                  top: -4,
                  right: -4,
                  width: 18,
                  height: 18,
                  borderRadius: "50%",
                  background: "var(--bg-3)",
                  color: "var(--text-1)",
                  fontSize: 11,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  border: "1px solid var(--border)",
                  cursor: "pointer",
                  padding: 0,
                }}
              >
                x
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Hidden file input */}
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        multiple
        style={{ display: "none" }}
        onChange={(e) => handleFiles(e.target.files)}
      />

      {/* Input */}
      <div
        style={{
          borderTop: "1px solid var(--border)",
          padding: "12px 0 0",
          display: "flex",
          gap: 8,
        }}
      >
        <button
          onClick={() => fileRef.current?.click()}
          style={{
            padding: "0 10px",
            background: "var(--bg-2)",
            color: "var(--text-1)",
            borderRadius: "var(--radius)",
            fontSize: 16,
            border: "1px solid var(--border)",
            cursor: "pointer",
            flexShrink: 0,
          }}
        >
          +
        </button>
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
          onFocus={(e) => (e.currentTarget.style.borderColor = "var(--border-bright)")}
          onBlur={(e) => (e.currentTarget.style.borderColor = "var(--border)")}
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
            disabled={!input.trim() && pendingImages.length === 0}
            style={{
              padding: "0 16px",
              background:
                input.trim() || pendingImages.length > 0 ? "var(--accent-dim)" : "var(--bg-3)",
              color: input.trim() || pendingImages.length > 0 ? "var(--accent)" : "var(--text-2)",
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

function UserMessage({ blocks }: { blocks: ContentBlock[] }) {
  return (
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
      <div style={{ flex: 1, minWidth: 0 }}>
        {blocks.map((block, i) => {
          if (block.type === "text") {
            return (
              <div key={i} style={{ color: "var(--text-0)", whiteSpace: "pre-wrap" }}>
                {block.text}
              </div>
            );
          }
          if (block.type === "image") {
            return (
              <img
                key={i}
                src={`data:${block.media_type};base64,${block.data}`}
                alt=""
                style={{
                  maxWidth: 300,
                  maxHeight: 200,
                  borderRadius: "var(--radius)",
                  marginTop: 4,
                }}
              />
            );
          }
          return null;
        })}
      </div>
    </div>
  );
}

function AssistantMessage({
  blocks,
  isStreaming,
}: {
  blocks: ContentBlock[];
  isStreaming: boolean;
}) {
  // Build render items: text, tool pairs, images — in order
  const items: Array<
    | { kind: "text"; text: string }
    | { kind: "tool"; tool: ToolBlock }
    | { kind: "image"; media_type: string; data: string }
  > = [];

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (block.type === "text") {
      items.push({ kind: "text", text: block.text });
    } else if (block.type === "tool_use") {
      const tool: ToolBlock = { name: block.name, input: block.input };
      // Peek at next block for paired tool_result
      const next = blocks[i + 1];
      if (next && next.type === "tool_result") {
        tool.output = next.output;
        tool.isError = next.is_error;
        i++; // skip the tool_result
      }
      items.push({ kind: "tool", tool });
    } else if (block.type === "tool_result") {
      // Orphaned tool_result (not paired with tool_use) — skip
    } else if (block.type === "image") {
      items.push({
        kind: "image",
        media_type: block.media_type,
        data: block.data,
      });
    }
  }

  const hasContent = items.length > 0;

  return (
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
        {!hasContent && isStreaming && (
          <span
            style={{
              color: "var(--text-2)",
              animation: "pulse 1.5s ease infinite",
            }}
          >
            thinking...
          </span>
        )}
        {items.map((item, j) => {
          if (item.kind === "tool") {
            return <ToolUseBlock key={j} tool={item.tool} />;
          }
          if (item.kind === "image") {
            return (
              <img
                key={j}
                src={`data:${item.media_type};base64,${item.data}`}
                alt=""
                style={{
                  maxWidth: 300,
                  maxHeight: 200,
                  borderRadius: "var(--radius)",
                  marginTop: 4,
                }}
              />
            );
          }
          // text
          return (
            <div key={j} style={{ color: "var(--text-0)" }}>
              <div
                className="markdown-body"
                dangerouslySetInnerHTML={{
                  __html: marked.parse(item.text) as string,
                }}
              />
              {isStreaming && j === items.length - 1 && (
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
          );
        })}
      </div>
    </div>
  );
}

function getToolSummary(tool: ToolBlock): { label: string; color: string } {
  const inp = tool.input as Record<string, unknown>;
  switch (tool.name) {
    case "Read":
      return { label: `Read ${inp.file_path ?? ""}`, color: "var(--blue)" };
    case "Write":
      return { label: `Write ${inp.file_path ?? ""}`, color: "var(--blue)" };
    case "Edit":
      return { label: `Edit ${inp.file_path ?? ""}`, color: "var(--blue)" };
    case "Glob":
      return { label: `Glob ${inp.pattern ?? ""}`, color: "var(--yellow)" };
    case "Grep":
      return {
        label: `Grep "${inp.pattern ?? ""}"${inp.path ? ` in ${inp.path}` : ""}`,
        color: "var(--yellow)",
      };
    case "Bash":
      return {
        label: `Bash: ${String(inp.command ?? "").split("\n")[0]}`,
        color: "var(--red)",
      };
    case "WebSearch":
      return { label: `Search: "${inp.query ?? ""}"`, color: "var(--purple)" };
    case "WebFetch":
      return { label: `Fetch: ${inp.url ?? ""}`, color: "var(--purple)" };
    case "Task":
      return { label: `Task: ${inp.description ?? ""}`, color: "var(--accent)" };
    default:
      return { label: tool.name, color: "var(--purple)" };
  }
}

function ToolUseBlock({ tool }: { tool: ToolBlock }) {
  const [open, setOpen] = useState(false);
  const summary = getToolSummary(tool);

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
          color: summary.color,
          fontSize: 12,
          fontFamily: "var(--mono)",
          textAlign: "left",
        }}
      >
        <span
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            flex: 1,
            minWidth: 0,
          }}
        >
          <span style={{ color: "var(--text-2)", marginRight: 6 }}>{open ? "v" : ">"}</span>
          {summary.label}
        </span>
        {tool.output !== undefined && (
          <span
            style={{
              color: tool.isError ? "var(--red)" : "var(--accent)",
              fontSize: 10,
              flexShrink: 0,
              marginLeft: 8,
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
