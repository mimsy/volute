<script lang="ts">
// Island entry point: the vendored timeline rendering fern's morning.
import "./timeline.css";
import {
  DEFAULT_EXPANDED_TURN,
  items,
  MIND_NAME,
  STATUS_COLOR,
  STATUS_LABEL,
  summaryChildren,
  summaryDirectEvents,
} from "./fixture";
import StaticTimeline from "./StaticTimeline.svelte";
</script>

<div class="volute-embed">
  <StaticTimeline
    {items}
    name={MIND_NAME}
    statusLabel={STATUS_LABEL}
    statusColor={STATUS_COLOR}
    defaultExpandedTurnId={DEFAULT_EXPANDED_TURN}
    {summaryChildren}
    {summaryDirectEvents}
  />
</div>
