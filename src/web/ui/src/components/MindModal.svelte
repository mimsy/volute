<script lang="ts">
import type { Mind } from "@volute/api";
import MindRightPanel from "./MindRightPanel.svelte";

let {
  mind,
  onProfile,
}: {
  mind: Mind;
  onProfile?: () => void;
} = $props();
</script>

<MindRightPanel {mind} {onProfile} />
