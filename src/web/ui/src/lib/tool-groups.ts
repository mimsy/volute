import type { HistoryMessage, TurnActivity, TurnConversation } from "@volute/api";
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
 * Groups sequential tool_use + tool_result pairs into ToolGroup items.
 * Non-tool events between a pair become standalone items after the group.
 * Linked conversations/activities stay attached to the tool_use event id
 * and render separately via the existing source_event_id mechanism.
 */
export function groupToolEvents(
  events: HistoryMessage[],
  _conversations: TurnConversation[],
  _activities: TurnActivity[],
): TimelineItem[] {
  const items: TimelineItem[] = [];
  let i = 0;

  while (i < events.length) {
    const ev = events[i];

    if (ev.type === "tool_use") {
      const toolMeta = parseMeta(ev.metadata);
      const rawName = typeof toolMeta?.name === "string" ? toolMeta.name : "tool";
      const toolName = normalizeToolName(rawName);
      const category = getToolCategory(rawName);

      // Look ahead for the matching tool_result
      const interleaved: HistoryMessage[] = [];
      let result: HistoryMessage | null = null;
      let j = i + 1;
      while (j < events.length) {
        if (events[j].type === "tool_result") {
          result = events[j];
          j++;
          break;
        }
        if (events[j].type === "tool_use") {
          // Next tool_use without a result — stop looking
          break;
        }
        interleaved.push(events[j]);
        j++;
      }

      items.push({
        kind: "tool-group",
        toolUse: ev,
        toolResult: result,
        toolName,
        category,
      });

      // Interleaved non-tool events appear after the group
      for (const ie of interleaved) {
        items.push({ kind: "event", event: ie });
      }

      i = j;
    } else {
      items.push({ kind: "event", event: ev });
      i++;
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
