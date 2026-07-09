import type { HistoryMessage } from "@volute/api";
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
        result = resultsById.get(id) ?? null;
        if (result) claimed.add(result);
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

function parseMeta(metadata: string | null): Record<string, unknown> | null {
  if (!metadata) return null;
  try {
    return JSON.parse(metadata);
  } catch {
    return null;
  }
}
