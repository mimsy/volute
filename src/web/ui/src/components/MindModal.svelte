<script lang="ts">
import type { Mind } from "@volute/api";
import MindRightPanel from "./MindRightPanel.svelte";

let {
  mind,
  onClose,
  onViewProfile,
}: {
  mind: Mind;
  onClose?: () => void;
  onViewProfile?: () => void;
} = $props();
</script>

<MindRightPanel {mind} header {onClose} {onViewProfile} />
