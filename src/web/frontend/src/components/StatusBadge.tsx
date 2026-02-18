const statusConfig: Record<string, { color: string; bg: string; glow?: boolean; label: string }> = {
  active: { color: "var(--accent)", bg: "var(--accent-bg)", glow: true, label: "active" },
  running: { color: "var(--accent)", bg: "var(--accent-bg)", glow: true, label: "awake" },
  starting: { color: "var(--yellow)", bg: "rgba(251, 191, 36, 0.08)", label: "waking" },
  stopped: { color: "var(--text-2)", bg: "rgba(106, 117, 136, 0.08)", label: "asleep" },
  connected: { color: "var(--blue)", bg: "rgba(96, 165, 250, 0.08)", label: "connected" },
  disconnected: { color: "var(--text-2)", bg: "rgba(106, 117, 136, 0.08)", label: "disconnected" },
  dead: { color: "var(--red)", bg: "rgba(248, 113, 113, 0.08)", label: "dead" },
  "no-server": { color: "var(--text-2)", bg: "rgba(106, 117, 136, 0.08)", label: "no-server" },
};

export function StatusBadge({ status }: { status: string }) {
  const config = statusConfig[status] ?? statusConfig.stopped;

  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        padding: "2px 8px",
        borderRadius: "var(--radius)",
        background: config.bg,
        color: config.color,
        fontSize: 11,
        fontWeight: 500,
        letterSpacing: "0.02em",
        textTransform: "uppercase",
      }}
    >
      <span
        style={{
          width: 5,
          height: 5,
          borderRadius: "50%",
          background: config.color,
          boxShadow: config.glow ? `0 0 6px ${config.color}` : "none",
          animation: status === "starting" ? "pulse 1.5s ease infinite" : "none",
        }}
      />
      {config.label}
    </span>
  );
}
