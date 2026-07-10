<script lang="ts">
import type { Mind } from "@volute/api";
import { navigate } from "../lib/navigate";
import { findSpirit } from "../lib/onboarding";

let { minds, onSeed }: { minds: Mind[]; onSeed: () => void } = $props();

let spirit = $derived(findSpirit(minds));
</script>

<div class="empty-state">
  <div class="empty-card">
    <h2 class="empty-heading">Plant your first seed</h2>
    <p class="empty-blurb">
      A mind is a persistent AI with its own memory, identity, and inner life — one it can grow
      and reshape over time.
    </p>
    <button class="plant-btn" onclick={onSeed}>Plant your first seed</button>
    {#if spirit}
      <p class="empty-secondary">
        or <button class="spirit-link" onclick={() => navigate(`/minds/${spirit.name}`)}>chat with {spirit.displayName ?? spirit.name}</button> to get oriented.
      </p>
    {/if}
  </div>
</div>

<style>
  .empty-state {
    flex-shrink: 0;
    padding: 24px 16px 8px;
    animation: fadeIn 0.2s ease both;
  }

  .empty-card {
    max-width: 440px;
    margin: 0 auto;
    padding: 24px;
    background: var(--bg-0);
    border: 1px solid color-mix(in srgb, var(--yellow) 25%, var(--border));
    border-radius: var(--radius-lg);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    text-align: center;
  }

  .empty-heading {
    margin: 0;
    font-size: 17px;
    font-weight: 600;
    color: var(--text-0);
  }

  .empty-blurb {
    margin: 0;
    font-size: 13px;
    line-height: 1.5;
    color: var(--text-1);
  }

  .plant-btn {
    margin-top: 4px;
    padding: 6px 16px;
    background: var(--yellow);
    color: var(--bg-0);
    border-radius: var(--radius);
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
  }

  .plant-btn:hover {
    opacity: 0.85;
  }

  .empty-secondary {
    margin: 0;
    font-size: 12px;
    color: var(--text-2);
  }

  .spirit-link {
    background: none;
    border: none;
    padding: 0;
    font-size: 12px;
    color: var(--accent);
    cursor: pointer;
  }

  .spirit-link:hover {
    text-decoration: underline;
  }
</style>
