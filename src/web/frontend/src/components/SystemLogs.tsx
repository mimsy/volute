import { useCallback, useEffect, useRef, useState } from "react";
import { useSystemLogStream } from "../lib/useStream";

type LogEntry = {
  level: string;
  msg: string;
  ts: string;
  data?: Record<string, unknown>;
};

const LEVEL_COLORS: Record<string, string> = {
  info: "var(--text-2)",
  warn: "var(--yellow)",
  error: "var(--red)",
};

export function SystemLogs() {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [autoScroll, setAutoScroll] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  const onLine = useCallback((line: string) => {
    try {
      const entry = JSON.parse(line) as LogEntry;
      setEntries((prev) => {
        const next = [...prev, entry];
        return next.length > 2000 ? next.slice(-2000) : next;
      });
    } catch {
      // skip invalid
    }
  }, []);

  const { start, stop } = useSystemLogStream(onLine);

  useEffect(() => {
    start();
    return stop;
  }, [start, stop]);

  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [entries, autoScroll]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
    setAutoScroll(atBottom);
  };

  const formatTime = (ts: string) => {
    try {
      return new Date(ts).toLocaleTimeString();
    } catch {
      return ts;
    }
  };

  const formatData = (data: Record<string, unknown>) => {
    return Object.entries(data)
      .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
      .join(" ");
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "calc(100vh - 48px - 48px)" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 12,
          flexShrink: 0,
        }}
      >
        <span style={{ color: "var(--text-1)", fontSize: 13, fontWeight: 500 }}>System Logs</span>
        <span style={{ color: "var(--text-2)", fontSize: 11 }}>{entries.length} entries</span>
      </div>
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
            flexShrink: 0,
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
          color: "var(--text-1)",
          background: "var(--bg-0)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-lg)",
        }}
      >
        {entries.length === 0 && (
          <span style={{ color: "var(--text-2)" }}>Waiting for logs...</span>
        )}
        {entries.map((entry, i) => (
          <div key={i} style={{ animation: "fadeIn 0.1s ease both", whiteSpace: "pre-wrap" }}>
            <span style={{ color: "var(--text-2)" }}>{formatTime(entry.ts)}</span>{" "}
            <span style={{ color: LEVEL_COLORS[entry.level] || "var(--text-2)" }}>
              {entry.level.padEnd(5)}
            </span>{" "}
            <span style={{ color: "var(--text-0)" }}>{entry.msg}</span>
            {entry.data && (
              <span style={{ color: "var(--text-2)" }}> {formatData(entry.data)}</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
