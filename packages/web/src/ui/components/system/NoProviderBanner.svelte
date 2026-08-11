<script lang="ts">
// Persistent banner shown to admins when no AI provider is configured. Without a
// provider every mind spawns mute (no model to think with), so this surfaces the
// system-level gap and points at Settings to fix it (#606).
let { onOpenSettings }: { onOpenSettings: () => void } = $props();

let aiConfigured = $state(true);

$effect(() => {
  let mounted = true;

  async function poll() {
    try {
      const res = await fetch("/api/v1/system/info");
      if (!res.ok) {
        console.debug("[provider] poll returned", res.status);
        return;
      }
      const data = await res.json();
      if (mounted) aiConfigured = data.aiConfigured !== false;
    } catch (e) {
      console.debug("[provider] poll failed:", e);
    }
  }

  poll();
  const id = setInterval(poll, 60_000);
  return () => {
    mounted = false;
    clearInterval(id);
  };
});
</script>

{#if !aiConfigured}
  <div class="banner">
    <span>Minds cannot think yet — no AI provider is configured.</span>
    <button class="settings-btn" onclick={onOpenSettings}>add a provider in Settings</button>
  </div>
{/if}

<style>
  .banner {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 12px;
    padding: 6px 16px;
    background: var(--red-bg);
    border-bottom: 1px solid var(--red-border);
    color: var(--red);
    font-size: 13px;
    font-family: inherit;
    flex-shrink: 0;
  }

  .settings-btn {
    background: transparent;
    color: inherit;
    border: 1px solid currentColor;
    border-radius: var(--radius);
    padding: 2px 10px;
    font-size: 12px;
    font-family: inherit;
    cursor: pointer;
  }
</style>
