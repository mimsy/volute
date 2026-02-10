import { useEffect, useState } from "react";

type UpdateInfo = {
  current: string;
  latest: string;
  updateAvailable: boolean;
};

export function UpdateBanner() {
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [updating, setUpdating] = useState(false);

  useEffect(() => {
    let mounted = true;

    async function poll() {
      try {
        const res = await fetch("/api/health");
        if (!res.ok) return;
        const data = await res.json();
        if (mounted && data.updateAvailable) {
          setUpdate({ current: data.version, latest: data.latest, updateAvailable: true });
        } else if (mounted) {
          setUpdate(null);
        }
      } catch {}
    }

    poll();
    const id = setInterval(poll, 60_000);
    return () => {
      mounted = false;
      clearInterval(id);
    };
  }, []);

  if (!update?.updateAvailable || dismissed) return null;

  async function handleUpdate() {
    setUpdating(true);
    try {
      const res = await fetch("/api/system/update", { method: "POST" });
      if (!res.ok) {
        setUpdating(false);
        return;
      }

      // Poll health until new version responds
      const start = Date.now();
      const maxWait = 60_000;
      // Wait a bit for the daemon to stop
      await new Promise((r) => setTimeout(r, 3000));

      while (Date.now() - start < maxWait) {
        try {
          const healthRes = await fetch("/api/health");
          if (healthRes.ok) {
            const data = await healthRes.json();
            if (data.version !== update?.current) {
              window.location.reload();
              return;
            }
          }
        } catch {}
        await new Promise((r) => setTimeout(r, 2000));
      }
      // Timeout — reload anyway
      window.location.reload();
    } catch {
      setUpdating(false);
    }
  }

  return (
    <div style={bannerStyle}>
      {updating ? (
        <span style={{ animation: "pulse 1.5s ease-in-out infinite" }}>Updating...</span>
      ) : (
        <>
          <span>
            Update available: v{update.current} → v{update.latest}
          </span>
          <button onClick={handleUpdate} style={updateBtnStyle}>
            update
          </button>
          <button onClick={() => setDismissed(true)} style={dismissBtnStyle}>
            ×
          </button>
        </>
      )}
    </div>
  );
}

const bannerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 12,
  padding: "6px 16px",
  background: "var(--accent-bg)",
  borderBottom: "1px solid var(--accent-dim)",
  color: "var(--accent)",
  fontSize: 12,
  fontFamily: "var(--mono)",
  flexShrink: 0,
};

const updateBtnStyle: React.CSSProperties = {
  background: "var(--accent-dim)",
  color: "var(--accent)",
  border: "1px solid var(--accent)",
  borderRadius: "var(--radius)",
  padding: "2px 10px",
  fontSize: 11,
  fontFamily: "var(--mono)",
  cursor: "pointer",
};

const dismissBtnStyle: React.CSSProperties = {
  background: "transparent",
  color: "var(--accent)",
  border: "none",
  fontSize: 16,
  lineHeight: 1,
  cursor: "pointer",
  padding: "0 4px",
};
