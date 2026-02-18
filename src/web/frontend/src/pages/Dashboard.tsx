import { useEffect, useState } from "react";
import { MindCard } from "../components/MindCard";
import { SeedModal } from "../components/SeedModal";
import { fetchMinds, type Mind } from "../lib/api";

export function Dashboard() {
  const [minds, setMinds] = useState<Mind[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [showSeedModal, setShowSeedModal] = useState(false);

  useEffect(() => {
    let active = true;
    const poll = async () => {
      try {
        const data = await fetchMinds();
        if (active) {
          setMinds(data);
          setError("");
          setLoading(false);
        }
      } catch {
        if (active) {
          setError("Failed to connect to API");
          setLoading(false);
        }
      }
    };

    poll();
    const interval = setInterval(poll, 5000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, []);

  const handleSeedCreated = (mindName: string) => {
    setShowSeedModal(false);
    window.location.hash = `#/chats?mind=${mindName}`;
  };

  if (error) {
    return <div style={{ color: "var(--red)", padding: 40, textAlign: "center" }}>{error}</div>;
  }

  if (loading) {
    return null;
  }

  if (minds.length === 0) {
    return (
      <div
        style={{
          color: "var(--text-2)",
          padding: 40,
          textAlign: "center",
          fontSize: 14,
        }}
      >
        <div style={{ marginBottom: 8 }}>No minds registered.</div>
        <div style={{ display: "flex", gap: 12, justifyContent: "center", marginTop: 16 }}>
          <code style={{ color: "var(--text-1)" }}>volute mind create &lt;name&gt;</code>
          <span style={{ color: "var(--text-2)" }}>or</span>
          <button
            onClick={() => setShowSeedModal(true)}
            style={{
              padding: "4px 12px",
              background: "rgba(251, 191, 36, 0.08)",
              color: "var(--yellow)",
              borderRadius: "var(--radius)",
              fontSize: 12,
              fontWeight: 500,
              border: "1px solid rgba(251, 191, 36, 0.2)",
              cursor: "pointer",
            }}
          >
            plant a seed
          </button>
        </div>
        {showSeedModal && (
          <SeedModal onClose={() => setShowSeedModal(false)} onCreated={handleSeedCreated} />
        )}
      </div>
    );
  }

  return (
    <>
      <div style={{ marginBottom: 16 }}>
        <button
          onClick={() => setShowSeedModal(true)}
          style={{
            padding: "6px 14px",
            background: "rgba(251, 191, 36, 0.08)",
            color: "var(--yellow)",
            borderRadius: "var(--radius)",
            fontSize: 12,
            fontWeight: 500,
            border: "1px solid rgba(251, 191, 36, 0.2)",
            cursor: "pointer",
          }}
        >
          plant a seed
        </button>
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
          gap: 16,
          maxWidth: 1200,
        }}
      >
        {minds.map((mind, i) => (
          <div
            key={mind.name}
            style={{
              animation: "fadeIn 0.3s ease both",
              animationDelay: `${i * 50}ms`,
            }}
          >
            <MindCard mind={mind} />
          </div>
        ))}
      </div>
      {showSeedModal && (
        <SeedModal onClose={() => setShowSeedModal(false)} onCreated={handleSeedCreated} />
      )}
    </>
  );
}
