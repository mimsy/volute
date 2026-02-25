<script lang="ts">
let { status }: { status: string } = $props();

const statusConfig: Record<
  string,
  { color: string; bg: string; iridescent?: boolean; label: string }
> = {
  active: { color: "var(--text-0)", bg: "var(--muted-bg)", iridescent: true, label: "active" },
  running: { color: "var(--text-0)", bg: "var(--muted-bg)", label: "awake" },
  starting: { color: "var(--yellow)", bg: "var(--yellow-bg)", label: "waking" },
  stopped: { color: "var(--text-2)", bg: "var(--muted-bg)", label: "asleep" },
  connected: { color: "var(--blue)", bg: "var(--blue-bg)", label: "connected" },
  disconnected: { color: "var(--text-2)", bg: "var(--muted-bg)", label: "disconnected" },
  dead: { color: "var(--red)", bg: "var(--red-bg)", label: "dead" },
  "no-server": { color: "var(--text-2)", bg: "var(--muted-bg)", label: "no-server" },
};

let config = $derived(statusConfig[status] ?? statusConfig.stopped);
</script>

<span
  class="badge"
  style:background={config.bg}
  style:color={config.color}
>
  <span
    class="dot"
    class:iridescent={config.iridescent}
    style:background={config.iridescent ? undefined : config.color}
    style:animation={status === "starting" ? "pulse 1.5s ease infinite" : "none"}
  ></span>
  {config.label}
</span>

<style>
  .badge {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 2px 8px;
    border-radius: var(--radius);
    font-size: 11px;
    font-weight: 500;
    letter-spacing: 0.02em;
    text-transform: uppercase;
  }

  .dot {
    width: 5px;
    height: 5px;
    border-radius: 50%;
  }

  .dot.iridescent {
    animation: iridescent 3s ease-in-out infinite;
  }

  @keyframes iridescent {
    0%   { background: #4ade80; }
    16%  { background: #60a5fa; }
    33%  { background: #c084fc; }
    50%  { background: #f472b6; }
    66%  { background: #fbbf24; }
    83%  { background: #34d399; }
    100% { background: #4ade80; }
  }
</style>
