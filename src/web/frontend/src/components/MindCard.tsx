import type { Mind } from "../lib/api";
import { StatusBadge } from "./StatusBadge";

export function MindCard({ mind }: { mind: Mind }) {
  return (
    <a
      href={`#/mind/${mind.name}`}
      style={{
        display: "block",
        padding: 20,
        background: "var(--bg-2)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-lg)",
        cursor: "pointer",
        transition: "all 0.15s ease",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = "var(--border-bright)";
        e.currentTarget.style.background = "var(--bg-3)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = "var(--border)";
        e.currentTarget.style.background = "var(--bg-2)";
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 12,
        }}
      >
        <span
          style={{
            fontSize: 15,
            fontWeight: 600,
            color: "var(--text-0)",
          }}
        >
          {mind.name}
        </span>
        {mind.stage === "seed" && (
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              padding: "2px 8px",
              borderRadius: "var(--radius)",
              background: "rgba(251, 191, 36, 0.08)",
              color: "var(--yellow)",
              fontSize: 11,
              fontWeight: 500,
              letterSpacing: "0.02em",
              textTransform: "uppercase",
            }}
          >
            seed
          </span>
        )}
        <StatusBadge status={mind.status} />
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 16,
          color: "var(--text-2)",
          fontSize: 12,
        }}
      >
        <span>:{mind.port}</span>
        {mind.channels
          .filter((ch) => ch.name !== "web" && ch.status === "connected")
          .map((ch) => (
            <span
              key={ch.name}
              style={{
                fontSize: 10,
                padding: "2px 6px",
                borderRadius: "var(--radius)",
                background: "var(--accent-dim)",
                color: "var(--accent)",
              }}
            >
              {ch.displayName || ch.name}
            </span>
          ))}
      </div>
    </a>
  );
}
