import { useCallback, useEffect, useRef, useState } from "react";
import { useLogStream } from "../lib/useStream";

export function LogViewer({ name }: { name: string }) {
  const [lines, setLines] = useState<string[]>([]);
  const [autoScroll, setAutoScroll] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  const onLine = useCallback((line: string) => {
    setLines((prev) => {
      const next = [...prev, line];
      // Keep last 2000 lines
      return next.length > 2000 ? next.slice(-2000) : next;
    });
  }, []);

  const { start, stop } = useLogStream(name, onLine);

  useEffect(() => {
    start();
    return stop;
  }, [start, stop]);

  // Auto-scroll
  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [autoScroll]);

  // Detect scroll position
  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
    setAutoScroll(atBottom);
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
      }}
    >
      {!autoScroll && (
        <div
          style={{
            padding: "6px 12px",
            background: "var(--bg-3)",
            borderBottom: "1px solid var(--border)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            fontSize: 11,
            color: "var(--text-2)",
          }}
        >
          <span>Scroll paused</span>
          <button
            onClick={() => {
              setAutoScroll(true);
              if (scrollRef.current) {
                scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
              }
            }}
            style={{
              background: "var(--accent-dim)",
              color: "var(--accent)",
              padding: "2px 10px",
              borderRadius: "var(--radius)",
              fontSize: 11,
            }}
          >
            Resume
          </button>
        </div>
      )}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        style={{
          flex: 1,
          overflow: "auto",
          padding: 12,
          fontFamily: "var(--mono)",
          fontSize: 11,
          lineHeight: 1.7,
          whiteSpace: "pre-wrap",
          wordBreak: "break-all",
          color: "var(--text-1)",
          background: "var(--bg-0)",
        }}
      >
        {lines.length === 0 && <span style={{ color: "var(--text-2)" }}>Waiting for logs...</span>}
        {lines.map((line, i) => (
          <div key={i} style={{ animation: "fadeIn 0.1s ease both" }}>
            {line}
          </div>
        ))}
      </div>
    </div>
  );
}
