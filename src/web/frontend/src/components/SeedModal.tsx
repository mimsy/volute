import { useEffect, useRef, useState } from "react";
import { createSeedMind, startMind } from "../lib/api";

const inputStyle = {
  background: "var(--bg-2)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius)",
  padding: "8px 10px",
  color: "var(--text-0)",
  fontSize: 13,
  outline: "none",
  fontFamily: "var(--mono)",
} as const;

export function SeedModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (name: string) => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [template, setTemplate] = useState("agent-sdk");
  const [model, setModel] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  const handleSubmit = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setLoading(true);
    setError("");
    try {
      await createSeedMind(trimmed, {
        description: description.trim() || undefined,
        template,
        model: model.trim() || undefined,
      });
      await startMind(trimmed);
      onCreated(trimmed);
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
          padding: 24,
          width: 340,
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ fontWeight: 600, color: "var(--text-0)", fontSize: 14 }}>Plant a seed</div>

        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ color: "var(--text-2)", fontSize: 11 }}>Name</span>
          <input
            ref={nameRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. luna"
            onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
            style={inputStyle}
          />
        </label>

        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ color: "var(--text-2)", fontSize: 11 }}>Description (optional)</span>
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="A curious mind who loves poetry..."
            onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
            style={inputStyle}
          />
        </label>

        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ color: "var(--text-2)", fontSize: 11 }}>Template</span>
          <select
            value={template}
            onChange={(e) => setTemplate(e.target.value)}
            style={{ ...inputStyle, appearance: "auto" }}
          >
            <option value="agent-sdk">agent-sdk</option>
            <option value="pi">pi</option>
          </select>
        </label>

        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ color: "var(--text-2)", fontSize: 11 }}>Model (optional)</span>
          <input
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="e.g. claude-sonnet-4-5-20250929"
            onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
            style={inputStyle}
          />
        </label>

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
            onClick={handleSubmit}
            disabled={loading || !name.trim()}
            style={{
              padding: "6px 14px",
              background: "var(--yellow)",
              color: "var(--bg-0)",
              borderRadius: "var(--radius)",
              fontSize: 12,
              fontWeight: 600,
              opacity: loading || !name.trim() ? 0.5 : 1,
            }}
          >
            {loading ? "Planting..." : "Plant"}
          </button>
        </div>
      </div>
    </div>
  );
}
