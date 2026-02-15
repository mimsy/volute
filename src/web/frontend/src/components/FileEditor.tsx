import { useEffect, useState } from "react";
import { fetchFile, fetchFiles } from "../lib/api";

export function FileEditor({ name }: { name: string }) {
  const [files, setFiles] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    fetchFiles(name)
      .then((f) => {
        setFiles(f);
        if (f.length > 0 && !selected) setSelected(f[0]);
      })
      .catch(() => setError("Failed to load files"));
  }, [name, selected]);

  useEffect(() => {
    if (!selected) return;
    fetchFile(name, selected)
      .then((f) => {
        setContent(f.content);
        setError("");
      })
      .catch(() => setError("Failed to load file"));
  }, [name, selected]);

  return (
    <div
      style={{
        display: "flex",
        height: "100%",
        gap: 0,
      }}
    >
      {/* File list sidebar */}
      <div
        style={{
          width: 160,
          flexShrink: 0,
          borderRight: "1px solid var(--border)",
          padding: "8px 0",
          overflow: "auto",
        }}
      >
        {files.map((f) => (
          <button
            key={f}
            onClick={() => setSelected(f)}
            style={{
              display: "block",
              width: "100%",
              padding: "6px 12px",
              textAlign: "left",
              background: f === selected ? "var(--accent-bg)" : "transparent",
              color: f === selected ? "var(--accent)" : "var(--text-1)",
              fontSize: 12,
              fontFamily: "var(--mono)",
              borderLeft: f === selected ? "2px solid var(--accent)" : "2px solid transparent",
              transition: "all 0.1s",
            }}
          >
            {f}
          </button>
        ))}
      </div>

      {/* Viewer */}
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          minWidth: 0,
        }}
      >
        {selected && (
          <>
            <div
              style={{
                padding: "8px 12px",
                borderBottom: "1px solid var(--border)",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                fontSize: 12,
              }}
            >
              <span style={{ color: "var(--text-1)" }}>{selected}</span>
              {error && <span style={{ color: "var(--red)", fontSize: 11 }}>{error}</span>}
            </div>
            <textarea
              value={content}
              readOnly
              spellCheck={false}
              style={{
                flex: 1,
                padding: 12,
                background: "var(--bg-0)",
                color: "var(--text-0)",
                fontFamily: "var(--mono)",
                fontSize: 12,
                lineHeight: 1.7,
                border: "none",
                outline: "none",
                resize: "none",
                tabSize: 2,
              }}
            />
          </>
        )}
      </div>
    </div>
  );
}
