<script lang="ts">
import type { Snippet } from "svelte";
import type { HTMLButtonAttributes } from "svelte/elements";

let {
  variant = "secondary",
  size = "sm",
  children,
  class: className,
  ...rest
}: HTMLButtonAttributes & {
  variant?: "primary" | "secondary" | "danger" | "text" | "icon";
  size?: "sm" | "md";
  children: Snippet;
  class?: string;
} = $props();
</script>

<button class="btn {variant} {size} {className ?? ''}" {...rest}>
  {@render children()}
</button>

<style>
  .btn {
    border-radius: var(--radius);
    font-weight: 500;
    font-family: inherit;
    flex-shrink: 0;
    cursor: pointer;
    border: none;
    transition: opacity 0.15s;
  }

  .btn:disabled {
    opacity: 0.5;
    cursor: default;
  }

  /* Sizes */
  .sm {
    padding: 4px 12px;
    font-size: 12px;
  }

  .md {
    padding: 6px 14px;
    font-size: 13px;
  }

  /* Variants */
  .primary {
    background: var(--accent-dim);
    color: var(--accent);
  }

  .secondary {
    background: var(--bg-3);
    color: var(--text-2);
  }

  .secondary:hover:not(:disabled) {
    color: var(--text-0);
  }

  .danger {
    background: var(--bg-3);
    color: var(--text-2);
  }

  .danger:hover:not(:disabled) {
    color: var(--red);
  }

  .text {
    background: none;
    color: var(--text-2);
    padding-left: 0;
    padding-right: 0;
    text-decoration: underline;
  }

  .text:hover:not(:disabled) {
    color: var(--text-1);
  }

  .icon {
    padding: 2px 6px;
    font-size: 11px;
    background: var(--bg-3);
    color: var(--text-2);
  }

  .icon:hover:not(:disabled) {
    color: var(--text-0);
  }
</style>
