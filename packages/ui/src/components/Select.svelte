<script lang="ts">
import type { Snippet } from "svelte";
import type { HTMLSelectAttributes } from "svelte/elements";

let {
  children,
  value = $bindable(),
  class: className,
  ...rest
}: HTMLSelectAttributes & {
  children: Snippet;
  class?: string;
} = $props();
</script>

<select class="select {className ?? ''}" bind:value {...rest}>
	{@render children()}
</select>

<style>
	.select {
		background: var(--bg-2);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 4px 8px;
		font-size: 14px;
		font-family: inherit;
		color: var(--text-0);
	}

	.select:focus {
		border-color: var(--accent);
		outline: none;
	}

	.select:disabled {
		opacity: 0.5;
	}
</style>
