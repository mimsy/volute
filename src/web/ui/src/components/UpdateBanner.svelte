<script lang="ts">
type UpdateInfo = {
  current: string;
  latest: string;
  updateAvailable: boolean;
};

let update = $state<UpdateInfo | null>(null);
let dismissed = $state(false);
let updating = $state(false);
let error = $state<string | null>(null);

$effect(() => {
  let mounted = true;

  async function poll() {
    try {
      const res = await fetch("/api/health");
      if (!res.ok) return;
      const data = await res.json();
      if (mounted && data.updateAvailable) {
        update = { current: data.version, latest: data.latest, updateAvailable: true };
      } else if (mounted) {
        update = null;
      }
    } catch (e) {
      console.debug("[update] poll failed:", e);
    }
  }

  poll();
  const id = setInterval(poll, 60_000);
  return () => {
    mounted = false;
    clearInterval(id);
  };
});

async function handleUpdate() {
  updating = true;
  try {
    const res = await fetch("/api/system/update", { method: "POST" });
    if (!res.ok) {
      updating = false;
      error = "Update failed";
      setTimeout(() => {
        error = null;
      }, 5000);
      return;
    }

    const start = Date.now();
    const maxWait = 60_000;
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
      } catch (e) {
        console.debug("[update] health check failed:", e);
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    window.location.reload();
  } catch {
    updating = false;
    error = "Update failed";
    setTimeout(() => {
      error = null;
    }, 5000);
  }
}
</script>

{#if update?.updateAvailable && !dismissed}
  <div class="banner">
    {#if error}
      <span class="error">{error}</span>
    {:else if updating}
      <span class="updating">Updating...</span>
    {:else}
      <span>Update available: v{update.current} &rarr; v{update.latest}</span>
      <button class="update-btn" onclick={handleUpdate}>update</button>
      <button class="dismiss-btn" onclick={() => dismissed = true}>&times;</button>
    {/if}
  </div>
{/if}

<style>
  .banner {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 12px;
    padding: 6px 16px;
    background: var(--accent-bg);
    border-bottom: 1px solid var(--accent-dim);
    color: var(--accent);
    font-size: 12px;
    font-family: var(--mono);
    flex-shrink: 0;
  }

  .update-btn {
    background: var(--accent-dim);
    color: var(--accent);
    border: 1px solid var(--accent);
    border-radius: var(--radius);
    padding: 2px 10px;
    font-size: 11px;
    font-family: var(--mono);
    cursor: pointer;
  }

  .dismiss-btn {
    background: transparent;
    color: var(--accent);
    border: none;
    font-size: 16px;
    line-height: 1;
    cursor: pointer;
    padding: 0 4px;
  }

  .error {
    color: var(--red);
  }

  .updating {
    animation: pulse 1.5s ease-in-out infinite;
  }
</style>
