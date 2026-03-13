import { and, desc, eq, gt, lt, sql } from "drizzle-orm";
import { aiComplete } from "../ai-service.js";
import { getDb } from "../db.js";
import { publish as publishMindEvent } from "../events/mind-events.js";
import { summarizeTool } from "../format-tool.js";
import log from "../logger.js";
import { getPrompt } from "../prompts.js";
import { mindHistory } from "../schema.js";

const sLog = log.child("turn-summarizer");

type HistoryRow = {
  id: number;
  type: string;
  channel: string | null;
  session: string | null;
  content: string | null;
  metadata: string | null;
  created_at: string;
};

async function gatherTurnEvents(
  mind: string,
  session: string | undefined,
  doneId: number,
): Promise<{ events: HistoryRow[]; fromId: number; toId: number }> {
  const db = await getDb();

  // Find the previous "done" event for this mind+session to get the turn boundary
  const conditions = [
    eq(mindHistory.mind, mind),
    eq(mindHistory.type, "done"),
    lt(mindHistory.id, doneId),
  ];
  if (session) {
    conditions.push(eq(mindHistory.session, session));
  }

  const prevDone = await db
    .select({ id: mindHistory.id })
    .from(mindHistory)
    .where(and(...conditions))
    .orderBy(desc(mindHistory.id))
    .limit(1);

  const prevDoneId = prevDone.length > 0 ? prevDone[0].id : 0;

  // Get all events in this turn
  const turnConditions = [
    eq(mindHistory.mind, mind),
    gt(mindHistory.id, prevDoneId),
    sql`${mindHistory.id} <= ${doneId}`,
  ];
  if (session) {
    turnConditions.push(eq(mindHistory.session, session));
  }

  const events = await db
    .select({
      id: mindHistory.id,
      type: mindHistory.type,
      channel: mindHistory.channel,
      session: mindHistory.session,
      content: mindHistory.content,
      metadata: mindHistory.metadata,
      created_at: mindHistory.created_at,
    })
    .from(mindHistory)
    .where(and(...turnConditions))
    .orderBy(mindHistory.id);

  return {
    events,
    fromId: events.length > 0 ? events[0].id : doneId,
    toId: doneId,
  };
}

function buildDeterministicSummary(events: HistoryRow[]): string {
  const channels = new Set<string>();
  const tools: string[] = [];
  let hasInbound = false;
  let hasOutbound = false;

  for (const ev of events) {
    if (ev.type === "inbound") {
      hasInbound = true;
      if (ev.channel) channels.add(ev.channel);
    }
    if (ev.type === "outbound" || ev.type === "text") {
      hasOutbound = true;
    }
    if (ev.type === "tool_use" && ev.metadata) {
      try {
        const meta = JSON.parse(ev.metadata);
        if (meta.name) tools.push(meta.name);
      } catch (err) {
        sLog.debug(`failed to parse tool_use metadata for event ${ev.id}`, log.errorData(err));
      }
    }
  }

  const parts: string[] = [];
  if (hasInbound) {
    const channelList = [...channels];
    parts.push(
      channelList.length > 0 ? `Received message on ${channelList.join(", ")}` : "Received message",
    );
  }
  if (tools.length > 0) {
    const unique = [...new Set(tools)];
    parts.push(`Used ${unique.join(", ")}`);
  }
  if (hasOutbound) {
    parts.push("Sent response");
  }

  return parts.length > 0 ? `${parts.join(". ")}.` : "Turn completed.";
}

function buildTranscript(events: HistoryRow[]): string {
  const lines: string[] = [];
  for (const ev of events) {
    switch (ev.type) {
      case "inbound":
        lines.push(`[inbound${ev.channel ? ` ${ev.channel}` : ""}] ${ev.content ?? ""}`);
        break;
      case "outbound":
      case "text":
        lines.push(`[response] ${(ev.content ?? "").slice(0, 500)}`);
        break;
      case "tool_use": {
        let toolInfo = "tool";
        if (ev.metadata) {
          try {
            const meta = JSON.parse(ev.metadata);
            toolInfo = summarizeTool(meta.name ?? "tool", meta.input ?? {});
          } catch (err) {
            sLog.debug(`failed to parse tool_use metadata for event ${ev.id}`, log.errorData(err));
          }
        }
        lines.push(toolInfo);
        break;
      }
      case "tool_result": {
        const content = ev.content ?? "";
        let isError = false;
        if (ev.metadata) {
          try {
            const meta = JSON.parse(ev.metadata);
            isError = !!meta.is_error;
          } catch {}
        }
        lines.push(isError ? "[result error]" : `[result] ${content.slice(0, 200)}`);
        break;
      }
      case "thinking":
        lines.push(`[thinking] ${(ev.content ?? "").slice(0, 300)}`);
        break;
      // Skip usage, done — keep prompt compact
    }
  }
  return lines.join("\n");
}

export async function summarizeTurn(
  mind: string,
  session: string | undefined,
  channel: string | undefined,
  doneId: number,
): Promise<void> {
  const { events, fromId, toId } = await gatherTurnEvents(mind, session, doneId);

  if (events.length === 0) return;

  const tools: string[] = [];
  for (const ev of events) {
    if (ev.type === "tool_use" && ev.metadata) {
      try {
        const meta = JSON.parse(ev.metadata);
        if (meta.name) tools.push(meta.name);
      } catch (err) {
        sLog.debug(`failed to parse tool_use metadata for event ${ev.id}`, log.errorData(err));
      }
    }
  }

  const fromTime = events[0].created_at;
  const toTime = events[events.length - 1].created_at;

  // Try AI summary, fall back to deterministic
  let summaryText: string;
  let deterministic: boolean;

  const transcript = buildTranscript(events);
  if (transcript.trim()) {
    const summaryPrompt = await getPrompt("turn_summary");
    const aiResult = await aiComplete(summaryPrompt, transcript);
    if (aiResult) {
      summaryText = aiResult;
      deterministic = false;
    } else {
      summaryText = buildDeterministicSummary(events);
      deterministic = true;
    }
  } else {
    summaryText = buildDeterministicSummary(events);
    deterministic = true;
  }

  const metadata = {
    deterministic,
    tool_count: tools.length,
    tools: [...new Set(tools)],
    from_id: fromId,
    to_id: toId,
    from_time: fromTime,
    to_time: toTime,
  };

  // Persist summary
  const db = await getDb();
  try {
    await db.insert(mindHistory).values({
      mind,
      type: "summary",
      session: session ?? null,
      channel: channel ?? null,
      content: summaryText,
      metadata: JSON.stringify(metadata),
    });
  } catch (err) {
    sLog.error(
      `failed to persist summary for ${mind} (events ${fromId}-${toId})`,
      log.errorData(err),
    );
    return;
  }

  // Publish to SSE
  publishMindEvent(mind, {
    mind,
    type: "summary",
    session,
    channel,
    content: summaryText,
    metadata,
  });
}
