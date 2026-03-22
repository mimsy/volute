<script lang="ts">
import type { HTMLInputAttributes } from "svelte/elements";

let {
  variant = "default",
  inputSize = "sm",
  width,
  value = $bindable(),
  class: className,
  ...rest
}: HTMLInputAttributes & {
  variant?: "default" | "mono";
  inputSize?: "sm" | "md";
  width?: string;
  class?: string;
} = $props();
</script>

<input
	class="input {variant} {inputSize} {className ?? ''}"
	style:width={width}
	style:flex={width ? `0 0 ${width}` : undefined}
	bind:value
	{...rest}
/>

<style>
	.input {
		background: var(--bg-2);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 4px 8px;
		font-size: 14px;
		font-family: inherit;
		color: var(--text-0);
	}

	.input:focus {
		border-color: var(--accent);
		outline: none;
	}

	.input:disabled {
		opacity: 0.5;
	}

	.md {
		padding: 10px 12px;
		width: 100%;
	}

	.mono {
		font-family: var(--mono);
		font-size: 13px;
	}
</style>
