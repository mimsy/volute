import { useEffect, useState } from "react";
import { type AuthUser, approveUser, fetchUsers } from "../lib/auth";

export function UserManagement({ onClose }: { onClose: () => void }) {
  const [users, setUsers] = useState<AuthUser[]>([]);

  const refresh = () => {
    fetchUsers()
      .then(setUsers)
      .catch(() => {});
  };

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleApprove = async (id: number) => {
    await approveUser(id);
    refresh();
  };

  return (
    <div style={{ maxWidth: 600, animation: "fadeIn 0.2s ease both" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 16,
        }}
      >
        <h2 style={{ fontSize: 15, fontWeight: 600 }}>Users</h2>
        <button
          onClick={onClose}
          style={{
            background: "transparent",
            color: "var(--text-2)",
            fontSize: 12,
          }}
        >
          back
        </button>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {users.map((u) => (
          <div
            key={u.id}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "10px 14px",
              background: "var(--bg-2)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius)",
            }}
          >
            <div>
              <span style={{ color: "var(--text-0)", marginRight: 12 }}>{u.username}</span>
              <span
                style={{
                  fontSize: 11,
                  color:
                    u.role === "admin"
                      ? "var(--accent)"
                      : u.role === "pending"
                        ? "var(--yellow)"
                        : "var(--text-2)",
                }}
              >
                {u.role}
              </span>
            </div>
            {u.role === "pending" && (
              <button
                onClick={() => handleApprove(u.id)}
                style={{
                  padding: "4px 12px",
                  background: "var(--accent-dim)",
                  color: "var(--accent)",
                  borderRadius: "var(--radius)",
                  fontSize: 11,
                  fontWeight: 500,
                }}
              >
                approve
              </button>
            )}
          </div>
        ))}
        {users.length === 0 && (
          <div style={{ color: "var(--text-2)", textAlign: "center", padding: 24 }}>
            No users yet.
          </div>
        )}
      </div>
    </div>
  );
}
