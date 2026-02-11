import { useCallback, useEffect, useState } from "react";
import { fetchFile, fetchFiles, saveFile } from "../lib/api";

export function FileEditor({ name }: { name: string }) {
  const [files, setFiles] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [original, setOriginal] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
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
        setOriginal(f.content);
        setError("");
      })
      .catch(() => setError("Failed to load file"));
  }, [name, selected]);

  const handleSave = useCallback(async () => {
    if (!selected) return;
    setSaving(true);
    try {
      await saveFile(name, selected, content);
      setOriginal(content);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch {
      setError("Failed to save file");
    }
    setSaving(false);
  }, [name, selected, content]);

  const dirty = content !== original;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        if (dirty) handleSave();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [dirty, handleSave]);

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

      {/* Editor */}
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
              <span style={{ color: "var(--text-1)" }}>
                {selected}
                {dirty && <span style={{ color: "var(--yellow)", marginLeft: 6 }}>(modified)</span>}
              </span>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                {saved && (
                  <span
                    style={{
                      color: "var(--accent)",
                      fontSize: 11,
                      animation: "fadeIn 0.2s ease",
                    }}
                  >
                    Saved
                  </span>
                )}
                {error && <span style={{ color: "var(--red)", fontSize: 11 }}>{error}</span>}
                <button
                  onClick={handleSave}
                  disabled={!dirty || saving}
                  style={{
                    padding: "4px 12px",
                    background: dirty ? "var(--accent-dim)" : "var(--bg-3)",
                    color: dirty ? "var(--accent)" : "var(--text-2)",
                    borderRadius: "var(--radius)",
                    fontSize: 11,
                    fontWeight: 500,
                    transition: "all 0.15s",
                  }}
                >
                  {saving ? "Saving..." : "Save"}
                </button>
              </div>
            </div>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
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
