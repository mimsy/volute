import { useState, useEffect } from "react";
import { fetchVariants, type Variant } from "../lib/api";
import { StatusBadge } from "./StatusBadge";

export function VariantList({ name }: { name: string }) {
  const [variants, setVariants] = useState<Variant[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    fetchVariants(name).then(setVariants).catch(() => setError("Failed to load variants"));
  }, [name]);

  if (error) {
    return <div style={{ color: "var(--red)", padding: 16 }}>{error}</div>;
  }

  if (variants.length === 0) {
    return (
      <div style={{ color: "var(--text-2)", padding: 24, textAlign: "center" }}>
        No variants.
      </div>
    );
  }

  return (
    <div style={{ overflow: "auto" }}>
      <table
        style={{
          width: "100%",
          borderCollapse: "collapse",
          fontSize: 13,
        }}
      >
        <thead>
          <tr
            style={{
              textAlign: "left",
              color: "var(--text-2)",
              fontSize: 11,
              textTransform: "uppercase",
              letterSpacing: "0.04em",
            }}
          >
            <th style={{ padding: "8px 12px", borderBottom: "1px solid var(--border)" }}>
              Name
            </th>
            <th style={{ padding: "8px 12px", borderBottom: "1px solid var(--border)" }}>
              Branch
            </th>
            <th style={{ padding: "8px 12px", borderBottom: "1px solid var(--border)" }}>
              Port
            </th>
            <th style={{ padding: "8px 12px", borderBottom: "1px solid var(--border)" }}>
              Status
            </th>
          </tr>
        </thead>
        <tbody>
          {variants.map((v) => (
            <tr
              key={v.name}
              style={{
                animation: "fadeIn 0.2s ease both",
              }}
            >
              <td
                style={{
                  padding: "10px 12px",
                  borderBottom: "1px solid var(--border)",
                  color: "var(--text-0)",
                  fontWeight: 500,
                }}
              >
                {v.name}
              </td>
              <td
                style={{
                  padding: "10px 12px",
                  borderBottom: "1px solid var(--border)",
                  color: "var(--text-1)",
                }}
              >
                {v.branch}
              </td>
              <td
                style={{
                  padding: "10px 12px",
                  borderBottom: "1px solid var(--border)",
                  color: "var(--text-2)",
                }}
              >
                {v.port || "-"}
              </td>
              <td
                style={{
                  padding: "10px 12px",
                  borderBottom: "1px solid var(--border)",
                }}
              >
                <StatusBadge status={v.status} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
