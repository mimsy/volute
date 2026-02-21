<script lang="ts">
import { formatRelativeTime } from "../lib/format";

let {
  session,
  startedAt,
  eventCount,
  messageCount,
  toolCount,
}: {
  session: string;
  startedAt: string;
  eventCount: number;
  messageCount: number;
  toolCount: number;
} = $props();
</script>

<div class="divider">
  <div class="line"></div>
  <div class="label">
    <span class="session-id">{session}</span>
    <span class="sep">&middot;</span>
    <span>{formatRelativeTime(startedAt)}</span>
    <span class="sep">&middot;</span>
    <span>{eventCount} events</span>
    <span class="sep">&middot;</span>
    <span>{messageCount} msgs</span>
    <span class="sep">&middot;</span>
    <span>{toolCount} tools</span>
  </div>
  <div class="line"></div>
</div>

<style>
  .divider {
    display: flex;
    align-items: center;
    gap: 12px;
    margin: 20px 0 16px;
  }
  .line {
    flex: 1;
    border-top: 1px solid var(--border);
  }
  .label {
    font-size: 11px;
    color: var(--text-2);
    white-space: nowrap;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .session-id {
    color: var(--text-1);
    font-weight: 600;
  }
  .sep {
    color: var(--border-bright);
  }
</style>
