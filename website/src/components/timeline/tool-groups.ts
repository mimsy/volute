import type { HistoryMessage } from "./types";
import { getToolCategory, normalizeToolName, type ToolCategory } from "./tool-names";

export type ToolGroup = {
  kind: "tool-group";
  toolUse: HistoryMessage;
  toolResult: HistoryMessage | null;
  toolName: string;
  category: ToolCategory;
};

export type TimelineItem = { kind: "event"; event: HistoryMessage } | ToolGroup;

/**
 * Groups tool_use + tool_result pairs into ToolGroup items.
 *
 * Modern events carry ids: tool_use has `metadata.id` and tool_result has
 * `metadata.tool_use_id`. These are paired by id regardless of position, so
 * parallel tool calls (`use A, use B, result B, result A`) group correctly.
 *
 * Legacy events (pre-#388) lack `metadata.id` on the tool_use, so they fall
 * back to the positional scan: pair with the next unclaimed tool_result before
 * the next tool_use. Results never claimed by any group are emitted standalone
 * so nothing disappears. Groups render at the tool_use position.
 */
export function groupToolEvents(events: HistoryMessage[]): TimelineItem[] {
  // Index tool_result events by their tool_use_id for id-based matching.
  const resultsById = new Map<string, HistoryMessage>();
  for (const ev of events) {
    if (ev.type !== "tool_result") continue;
    const id = parseMeta(ev.metadata)?.tool_use_id;
    if (typeof id === "string" && !resultsById.has(id)) {
      resultsById.set(id, ev);
    }
  }

  const claimed = new Set<HistoryMessage>();
  const items: TimelineItem[] = [];

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];

    if (ev.type === "tool_use") {
      const toolMeta = parseMeta(ev.metadata);
      const rawName = typeof toolMeta?.name === "string" ? toolMeta.name : "tool";
      const toolName = normalizeToolName(rawName);
      const category = getToolCategory(rawName);
      const id = typeof toolMeta?.id === "string" ? toolMeta.id : null;

      let result: HistoryMessage | null = null;
      if (id !== null) {
        // Modern event: claim the matching result by id, regardless of position.
        // Skip a result a prior group already claimed so nothing renders twice.
        const r = resultsById.get(id) ?? null;
        if (r && !claimed.has(r)) {
          result = r;
          claimed.add(r);
        }
      } else {
        // Legacy event (no id): pair with the next unclaimed tool_result
        // before the next tool_use.
        for (let j = i + 1; j < events.length; j++) {
          if (events[j].type === "tool_use") break;
          if (events[j].type === "tool_result" && !claimed.has(events[j])) {
            result = events[j];
            claimed.add(events[j]);
            break;
          }
        }
      }

      items.push({
        kind: "tool-group",
        toolUse: ev,
        toolResult: result,
        toolName,
        category,
      });
    } else if (ev.type === "tool_result") {
      // Emit standalone only if no group claimed this result.
      if (!claimed.has(ev)) {
        items.push({ kind: "event", event: ev });
      }
    } else {
      items.push({ kind: "event", event: ev });
    }
  }

  return items;
}

/**
 * Incrementally folds a single streaming event into an already-grouped list,
 * producing a new array deep-equal to `groupToolEvents([...events, ev])` for the
 * live-stream shape: modern id-bearing events arriving in emission order (a
 * tool_use always precedes its tool_result). Existing group references are reused
 * except for the one group a tool_result attaches to, so appending is O(groups)
 * worst case and O(1) for the common trailing-append, instead of re-grouping the
 * whole array on every event.
 *
 * `groupToolEvents` stays the authority for everything else — out-of-order
 * results, and legacy (id-less) sequences where a result must span an intervening
 * open tool_use, both of which this helper groups differently. Those only reach
 * grouping through the DB-backfill path (`setStreaming` re-runs `groupToolEvents`),
 * never through this live append path, since a running daemon emits modern events.
 */
export function appendToGroups(groups: TimelineItem[], ev: HistoryMessage): TimelineItem[] {
  if (ev.type === "tool_use") {
    const toolMeta = parseMeta(ev.metadata);
    const rawName = typeof toolMeta?.name === "string" ? toolMeta.name : "tool";
    return [
      ...groups,
      {
        kind: "tool-group",
        toolUse: ev,
        toolResult: null,
        toolName: normalizeToolName(rawName),
        category: getToolCategory(rawName),
      },
    ];
  }

  if (ev.type === "tool_result") {
    const id = parseMeta(ev.metadata)?.tool_use_id;
    let targetIdx = -1;
    if (typeof id === "string") {
      // Modern: attach to the first open group whose tool_use id matches.
      for (let i = 0; i < groups.length; i++) {
        const g = groups[i];
        if (g.kind !== "tool-group" || g.toolResult !== null) continue;
        if (parseMeta(g.toolUse.metadata)?.id === id) {
          targetIdx = i;
          break;
        }
      }
    } else {
      // Legacy (no id): attach to the most recent still-open group, matching
      // groupToolEvents' positional "next unclaimed result before next use" rule.
      for (let i = groups.length - 1; i >= 0; i--) {
        const g = groups[i];
        if (g.kind === "tool-group" && g.toolResult === null) {
          targetIdx = i;
          break;
        }
      }
    }

    if (targetIdx === -1) {
      // No open group claims it — emit standalone, as groupToolEvents would.
      return [...groups, { kind: "event", event: ev }];
    }
    const updated = groups.slice();
    updated[targetIdx] = { ...(groups[targetIdx] as ToolGroup), toolResult: ev };
    return updated;
  }

  return [...groups, { kind: "event", event: ev }];
}

/**
 * Live-stream group update used on the append path. Takes the O(1) incremental
 * `appendToGroups` route for modern id-bearing events (what every running daemon
 * emits), but falls back to a full `groupToolEvents` re-group for legacy (id-less)
 * tool_results, whose incremental placement could otherwise differ from the batch
 * grouper for interleaved parallel calls. `prevGroups` is the grouping of `events`
 * without its last element; `events` already includes the just-appended `event`.
 * The result is deep-equal to `groupToolEvents(events)` for any in-order stream.
 */
export function appendStreamingGroups(
  prevGroups: TimelineItem[],
  events: HistoryMessage[],
  event: HistoryMessage,
): TimelineItem[] {
  if (event.type === "tool_result" && typeof parseMeta(event.metadata)?.tool_use_id !== "string") {
    return groupToolEvents(events);
  }
  return appendToGroups(prevGroups, event);
}

function parseMeta(metadata: string | null): Record<string, unknown> | null {
  if (!metadata) return null;
  try {
    return JSON.parse(metadata);
  } catch {
    return null;
  }
}
