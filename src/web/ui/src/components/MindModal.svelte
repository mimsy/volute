<script lang="ts">
import type { Mind } from "@volute/api";
import MindRightPanel from "./MindRightPanel.svelte";

let {
  mind,
}: {
  mind: Mind;
} = $props();
</script>

<MindRightPanel {mind} />
