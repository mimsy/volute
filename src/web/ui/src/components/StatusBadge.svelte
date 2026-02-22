<script lang="ts">
let { status }: { status: string } = $props();

const statusConfig: Record<string, { color: string; bg: string; glow?: boolean; label: string }> = {
  active: { color: "var(--accent)", bg: "var(--accent-bg)", glow: true, label: "active" },
  running: { color: "var(--accent)", bg: "var(--accent-bg)", glow: true, label: "awake" },
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
    style:background={config.color}
    style:box-shadow={config.glow ? `0 0 6px ${config.color}` : "none"}
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
</style>
