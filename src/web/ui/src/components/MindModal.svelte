<script lang="ts">
import type { Mind } from "@volute/api";
import MindRightPanel from "./MindRightPanel.svelte";

let {
  mind,
  onProfile,
  onChat,
}: {
  mind: Mind;
  onProfile?: () => void;
  onChat?: () => void;
} = $props();
</script>

<MindRightPanel {mind} {onProfile} {onChat} />
