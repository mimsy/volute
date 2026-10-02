import type { query } from "@anthropic-ai/claude-agent-sdk";
import { daemonEmit, type EventType } from "./daemon-client.js";
import { log, warn } from "./logger.js";
import { filterEvent, loadTransparencyPreset } from "./transparency.js";
import type { ReplyInstructionsMode, VoluteEvent } from "./types.js";
import {
  advanceBaseline,
  buildUsagePayload,
  hasUsageCounters,
  type ModelUsageMap,
  type ResultUsage,
  resumedBaseline,
} from "./usage.js";

/** A pending message's daemon-facing id (routing/channel key) paired with its channel `seq`. */
export type MessageIdEntry = {
  id: string | undefined;
  seq: number;
  /** It interrupted the turn it arrived in, so it runs as a turn of its own, not folded in. */
  interrupting?: boolean;
  /**
   * The uuid it was pushed to the SDK with, which a `result` lists among the user messages
   * its run consumed (`user_message_uuids`) — see the `result` handler.
   */
  uuid?: string;
  /**
   * A result handed it back without the SDK having said it ran it — one with no list from a
   * CLI that echoes (a delivery failure, a zeroed result). It may never run, so it is not
   * taken as a turn's driver on timing, nor named as the next turn's: only a frame naming it
   * binds it (see `consumeStream`).
   */
  unrun?: boolean;
};

/**
 * The delivery the next turn will answer, as far as the queue can tell: its head, past any
 * entry that may never run (`unrun`).
 */
export function nextQueued(messageIds: MessageIdEntry[]): MessageIdEntry | undefined {
  return messageIds.find((e) => !e.unrun);
}

export type StreamSession = {
  name: string;
  messageIds: MessageIdEntry[];
  currentMessageId?: string;
  currentSeq?: number;
  messageChannels: Map<string, MessageChannelEntry>;
};

/**
 * A pending message's channel (which its turn's events are attributed to), and what its reply
 * reminder needs: a batch has no `channel`, only a `replyChannel`.
 */
export type MessageChannelEntry = {
  channel?: string;
  replyChannel?: string;
  sender?: string;
  replyInstructions?: ReplyInstructionsMode;
};

export type StreamCallbacks = {
  onSessionId?: (sessionId: string) => void;
  /** Any non-system stream message: the model is working (the cold reset's idle clock). */
  onActivity?: () => void;
  broadcast: (event: VoluteEvent) => void;
  onTurnEnd?: () => void;
  onContextTokens?: (tokens: number) => void;
  /**
   * Acknowledge the message channel entry with this `seq` — its turn is done (either
   * it drove this turn directly, or it was folded into it; see the `result` handler).
   */
  ack: (seq: number) => void;
};

// Loaded once at startup — mind restarts on config changes
const preset = loadTransparencyPreset();

function emit(
  session: StreamSession,
  event: {
    type: EventType;
    content?: string;
    metadata?: Record<string, unknown>;
    covers?: string[];
  },
) {
  const channel = session.currentMessageId
    ? session.messageChannels.get(session.currentMessageId)?.channel
    : undefined;
  const filtered = filterEvent(preset, {
    ...event,
    session: session.name,
    channel,
    messageId: session.currentMessageId,
  });
  if (filtered) daemonEmit(filtered);
}

/** The most uuids a `result`'s `user_message_uuids` holds; a list this long may be cut short. */
const CONSUMED_LIST_CAP = 64;

/**
 * Take out of `session.messageIds` every entry the run that just produced `result` consumed
 * besides its driver, and return them.
 *
 * The SDK says which: `user_message_uuids` lists every user message the run took — a
 * message queued before the run started can be folded into it between tool rounds as
 * readily as one that arrived mid-run, so no timing rule can tell (#1319). An entry it does
 * not list (one that interrupted the run, or queued behind it) stays for a run of its own.
 *
 * Without the list (an older CLI), an entry is judged by timing: one pushed after the run
 * started was folded into it, one queued before it gets a run of its own — except that an
 * interrupting entry, and everything behind it, waits for the next. That rule is #1319
 * itself: an entry queued before the run that the SDK folded in anyway stays as a later
 * turn's driver. Nothing else can tell without the list; the CLI the template pins sends it
 * on every run of a message of ours (a result without it there runs none — see the caller).
 *
 * A list holding its full 64 may have been cut short: the SDK's CLI keeps the first 63 it
 * took plus the turn's own (the last of a batch it merged), and drops any it folds in after
 * that. It takes queued messages in the order they were pushed, so every entry pushed before
 * the last one it names was consumed too; one after that is judged by timing — which, as on
 * an older CLI, folds in a mid-run arrival the run may not have reached.
 */
function foldedEntries(
  session: StreamSession,
  preTurnPending: number,
  result: object,
  driver: MessageIdEntry | undefined,
): MessageIdEntry[] {
  const consumed = (result as { user_message_uuids?: unknown }).user_message_uuids;
  const listed = Array.isArray(consumed) ? new Set(consumed) : undefined;
  const entries = session.messageIds.splice(0);
  // The seq of the last-pushed entry a full list names — the driver too, which is the last
  // of a merged batch: every entry pushed before it was consumed.
  let through = -1;
  if (listed && listed.size >= CONSUMED_LIST_CAP) {
    for (const e of driver ? [driver, ...entries] : entries) {
      if (e.uuid !== undefined && listed.has(e.uuid)) through = Math.max(through, e.seq);
    }
  }
  const byTiming = !listed || listed.size >= CONSUMED_LIST_CAP;
  const folded: MessageIdEntry[] = [];
  let interrupted = false;
  for (const [i, entry] of entries.entries()) {
    if (entry.seq <= through || (entry.uuid !== undefined && listed?.has(entry.uuid))) {
      folded.push(entry);
      continue;
    }
    if (byTiming && i >= preTurnPending) {
      interrupted ||= entry.interrupting === true;
      if (!interrupted) {
        folded.push(entry);
        continue;
      }
    }
    session.messageIds.push(entry);
  }
  return folded;
}

/**
 * Whether this CLI echoes the uuids it was sent — on a turn's first frame
 * (`user_message_uuid`) and in its result's list — so a turn without one ran no message of
 * ours. Process-wide, not per stream: a rotated or fresh stream runs the same CLI, and its
 * first turn may be one of the SDK's own.
 */
let echoes = false;

/** Test seam: forget that the CLI echoes uuids, as an older one wouldn't. */
export function resetUuidEchoes(): void {
  echoes = false;
}

export async function consumeStream(
  stream: ReturnType<typeof query>,
  session: StreamSession,
  callbacks: StreamCallbacks,
  opts: { resumed?: boolean; restoredTotals?: ModelUsageMap } = {},
) {
  emit(session, { type: "session_start" });
  // How many queued message ids predate the current turn — see the pruning in
  // the result handler (#700).
  let preTurnPending = 0;
  /**
   * The previous result's per-model counters. They accumulate across the stream rather
   * than resetting per turn, so each turn's own share is the difference from this (#981).
   * A local, because its lifetime is exactly this stream's. A fresh stream opens the SDK's
   * accumulator at zero; a resumed one opens it at the totals its transcript saved, which
   * the caller reads for the first counted result's baseline (#1155) — see
   * `resumedBaseline`.
   */
  let prevModelUsage: ModelUsageMap;
  let checkRestoredTotals = opts.resumed === true;
  /** The main loop's model, as `system/init` names it — its key in `modelUsage`. */
  let mainModel: string | undefined;
  /**
   * The entry this turn answers. Taken on timing at the turn's first stream message, then
   * confirmed by what the SDK echoes: its first frame names the message it answers, and its
   * result lists what it consumed (#1319).
   */
  let driver: MessageIdEntry | undefined;
  /** The turn's first top-level frame is still to come. */
  let firstFrame = true;
  /** The turn was found to answer no message of ours: take no driver until it ends. */
  let driverless = false;
  const bind = (entry: MessageIdEntry | undefined) => {
    driver = entry;
    session.currentMessageId = entry?.id;
    session.currentSeq = entry?.seq;
  };
  for await (const msg of stream) {
    if (session.currentMessageId === undefined && !driverless) {
      const next = nextQueued(session.messageIds);
      if (next) session.messageIds.splice(session.messageIds.indexOf(next), 1);
      bind(next);
      preTurnPending = session.messageIds.length;
    }
    // Rebind before this frame's blocks are emitted, so they are tagged with the message the
    // turn answers. A frame naming another queued message takes it as the driver, and the one
    // taken on timing goes back to the head of the queue — still listed at the result, and so
    // covered, when the SDK merged the two into one batch (whose turn names its last). The
    // first frame of a turn naming nothing, from a CLI that echoes, is a turn of the SDK's own
    // (a background task's notification): it gives its driver back at once, so a stream that
    // dies mid-turn still covers it (agent.ts covers what is left in the queue).
    if (msg.type === "assistant" && !msg.parent_tool_use_id) {
      const stamped = (msg as { user_message_uuid?: unknown }).user_message_uuid;
      if (typeof stamped === "string") {
        echoes = true;
        const i =
          driver?.uuid === stamped ? -1 : session.messageIds.findIndex((e) => e.uuid === stamped);
        if (i !== -1) {
          const [found] = session.messageIds.splice(i, 1);
          if (i < preTurnPending) preTurnPending--;
          if (driver) {
            session.messageIds.unshift(driver);
            preTurnPending++;
          }
          delete found.unrun;
          bind(found);
          driverless = false;
        }
      } else if (firstFrame && echoes && driver) {
        session.messageIds.unshift(driver);
        preTurnPending++;
        bind(undefined);
        driverless = true;
      }
      firstFrame = false;
    }
    if ("session_id" in msg && msg.session_id) {
      callbacks.onSessionId?.(msg.session_id as string);
    }
    if (msg.type !== "system") callbacks.onActivity?.();
    if (msg.type === "system" && msg.subtype === "init") {
      mainModel = msg.model;
    }
    if (msg.type === "assistant") {
      const usage = msg.message.usage as unknown as Record<string, unknown> | undefined;
      const inputTokens = (usage?.input_tokens as number) ?? 0;
      const cacheCreation = (usage?.cache_creation_input_tokens as number) ?? 0;
      const cacheRead = (usage?.cache_read_input_tokens as number) ?? 0;
      const contextTokens = inputTokens + cacheCreation + cacheRead;
      if (contextTokens) callbacks.onContextTokens?.(contextTokens);
      for (const b of msg.message.content) {
        if (b.type === "thinking" && "thinking" in b && b.thinking) {
          const text = b.thinking as string;
          emit(session, { type: "thinking", content: text });
        } else if (b.type === "text") {
          const text = (b as { text: string }).text;
          emit(session, { type: "text", content: text });
        } else if (b.type === "tool_use") {
          const tb = b as { id: string; name: string; input: unknown };
          emit(session, {
            type: "tool_use",
            content: JSON.stringify(tb.input),
            metadata: { name: tb.name, id: tb.id },
          });
        }
      }
    }
    if (msg.type === "user") {
      // Tool result messages — the SDK sends these after tool execution.
      // Extract tool_result content blocks and emit them so the daemon can
      // link outbound records to the correct turn via correlation markers.
      const content = (msg as { message?: { content?: unknown[] } }).message?.content;
      if (Array.isArray(content)) {
        for (const b of content) {
          if (
            b &&
            typeof b === "object" &&
            "type" in b &&
            b.type === "tool_result" &&
            "content" in b
          ) {
            const resultContent = Array.isArray(b.content)
              ? b.content
                  .filter(
                    (c: unknown): c is { type: "text"; text: string } =>
                      !!c && typeof c === "object" && "type" in c && c.type === "text",
                  )
                  .map((c) => c.text)
                  .join("")
              : typeof b.content === "string"
                ? b.content
                : "";
            // A failed tool call must be recorded even when it produced no text
            // body, so downstream (summary transcript + timeline UI) can flag it.
            const isError = "is_error" in b && b.is_error === true;
            if (resultContent || isError) {
              const toolUseId =
                "tool_use_id" in b && typeof b.tool_use_id === "string" ? b.tool_use_id : "unknown";
              emit(session, {
                type: "tool_result",
                content: resultContent,
                metadata: { tool_use_id: toolUseId, is_error: isError },
              });
            }
          }
        }
      }
    }
    if (msg.type === "result") {
      const listed = (msg as { user_message_uuids?: unknown }).user_message_uuids;
      const consumed = Array.isArray(listed) ? listed : undefined;
      if (consumed) echoes = true;
      // The backstop to the first frame's rebind (a turn may end before any frame): a run
      // whose list leaves the driver out didn't answer it, and neither did one with no list
      // at all from a CLI that echoes — that turn ran no message of ours. Either way the
      // driver goes back to the head of the queue for the run that will answer it, and this
      // `done` names nothing it didn't run (#1319). The list keeps its first 63 entries, so
      // a driver it consumed is always in it. From a CLI that has never echoed (an older one)
      // the driver is trusted, as before.
      //
      // A zeroed result for a run that did take the driver has no list either: the driver
      // goes back too, marked `unrun`, and is covered when the stream ends (`emitDone`). If
      // the stream runs on, it stays queued, never taken on timing or named as the next turn's
      // — only a frame naming it binds it — and never acked, so the daemon holds its slot until
      // the slot ages out. Only a CLI that took a message and never ran it, on a stream that
      // lives on, can leave one there.
      const ranNothingOfOurs = consumed === undefined && echoes;
      const unanswered =
        driver?.uuid !== undefined &&
        (ranNothingOfOurs || (consumed !== undefined && !consumed.includes(driver.uuid)));
      if (unanswered) {
        session.currentMessageId = undefined;
        session.currentSeq = undefined;
      }
      if (session.currentMessageId) {
        session.messageChannels.delete(session.currentMessageId);
      }
      // Ack this turn's driving message, identified by seq (not position — see
      // message-channel.ts). Without this the channel's inFlight set strands an
      // entry per turn, which gets replayed verbatim on the next rotation (#764).
      if (session.currentSeq !== undefined) callbacks.ack(session.currentSeq);
      // Every delivery this turn finished, for the `done` below: its driver and each one
      // folded into it (#1207). Each folded entry is pruned, so it is never shifted in as the
      // NEXT turn's id, tagging that turn's rows with the wrong delivery (#700), and acked.
      const covers = session.currentMessageId !== undefined ? [session.currentMessageId] : [];
      const folded = ranNothingOfOurs
        ? []
        : foldedEntries(session, preTurnPending, msg, unanswered ? undefined : driver);
      if (unanswered && driver) {
        // Without a list, nothing says the SDK will ever run it (see `unrun`).
        if (ranNothingOfOurs) driver.unrun = true;
        session.messageIds.unshift(driver);
      }
      driver = undefined;
      firstFrame = true;
      driverless = false;
      for (const entry of folded) {
        if (entry.id !== undefined) {
          session.messageChannels.delete(entry.id);
          covers.push(entry.id);
        }
        callbacks.ack(entry.seq);
      }
      log("mind", `session "${session.name}": turn done`);
      // Log any error messages from the result
      const resultMsg = msg as Record<string, unknown>;
      if (Array.isArray(resultMsg.messages)) {
        for (const m of resultMsg.messages) {
          if (m && typeof m === "object" && "errorMessage" in m && m.errorMessage) {
            warn("mind", `session "${session.name}": agent error: ${m.errorMessage}`);
          }
        }
      }
      const result = msg as ResultUsage;
      let baseline = prevModelUsage;
      if (checkRestoredTotals && hasUsageCounters(result.modelUsage)) {
        checkRestoredTotals = false;
        const resumed = resumedBaseline(result, opts.restoredTotals, mainModel);
        baseline = resumed.baseline;
        if (!resumed.consistent) {
          log(
            "mind",
            opts.restoredTotals
              ? `session "${session.name}": resumed usage exceeds the transcript's restored totals — pricing the main model on its own usage`
              : `session "${session.name}": resumed with restored usage totals — pricing this turn on its own usage`,
          );
        }
      }
      const usage = buildUsagePayload(result, baseline, mainModel);
      // Carried forward even when there was no usage to emit: the counters moved
      // regardless, and a skipped baseline would bill the next turn for both.
      prevModelUsage = advanceBaseline(prevModelUsage, result.modelUsage);
      if (usage) {
        callbacks.broadcast({ type: "usage", ...usage });
        emit(session, { type: "usage", metadata: usage });
      }
      callbacks.broadcast({ type: "done" });
      emit(session, { type: "done", covers });
      session.currentMessageId = undefined;
      session.currentSeq = undefined;
      callbacks.onTurnEnd?.();
    }
  }
}
