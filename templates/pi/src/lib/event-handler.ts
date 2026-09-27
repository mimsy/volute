import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { flushFileChanges, trackFileChange } from "./auto-commit.js";
import { daemonEmit, type EventType } from "./daemon-client.js";
import type { IdentityWatch } from "./identity-watch.js";
import { log, warn } from "./logger.js";
import { filterEvent, loadTransparencyPreset } from "./transparency.js";
import type { UsageByModel, VoluteEvent } from "./types.js";
import { hasTokens, mergeSlices, sumAssistantUsage, usageSlice } from "./usage-slices.js";

/** The error field of an agent_end message (subset of AgentMessage). */
type AgentEndMessage = { errorMessage?: string };

export type EventSession = {
  name: string;
  messageIds: (string | undefined)[];
  currentMessageId?: string;
  messageChannels: Map<string, { channel: string; sender?: string }>;
  /**
   * Usage from subagents that ran during the current turn, per model. They run as
   * separate in-process agent sessions, so the parent's agent_end never sees their
   * messages — without this the spend cap would never count them. Drained at agent_end.
   */
  subagentUsage?: UsageByModel[];
};

export type EventHandlerOptions = {
  cwd: string;
  broadcast: (event: VoluteEvent) => void;
  onContextTokens?: (tokens: number) => void;
  /**
   * Returns true if this run is rotating or has rotated the session (rotation itself
   * happens once the run settles, not here) — see the identity reload below.
   */
  onTurnEnd?: () => boolean;
  /**
   * Watches the mind's own edits for identity-file changes (#998). pi composes the system
   * prompt once, at startup, so an edited SOUL.md/MEMORY.md/VOLUTE.md is inert until the
   * process restarts — the watch is fed here and drained at turn end.
   */
  identityWatch?: IdentityWatch;
  /** Requests the restart that puts an edited identity file into effect. */
  onIdentityReload?: () => void | Promise<void>;
  /**
   * `provider:model` of the main loop's configured model — names its usage slice when no
   * message this turn reported a model, so a subagent breakdown always has a main slice.
   */
  mainModel?: string;
};

// Loaded once at startup — mind restarts on config changes
const preset = loadTransparencyPreset();

export function emit(
  session: EventSession,
  event: { type: EventType; content?: string; metadata?: Record<string, unknown> },
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

export function createEventHandler(session: EventSession, options: EventHandlerOptions) {
  const toolArgs = new Map<string, Record<string, unknown>>();
  let textBuf = "";
  let thinkingBuf = "";

  function flushText() {
    if (textBuf) {
      emit(session, { type: "text", content: textBuf });
      textBuf = "";
    }
  }

  function flushThinking() {
    if (thinkingBuf) {
      emit(session, { type: "thinking", content: thinkingBuf });
      thinkingBuf = "";
    }
  }

  function flushBuffers() {
    flushThinking();
    flushText();
  }

  let sessionStarted = false;

  return (event: AgentSessionEvent) => {
    try {
      if (!sessionStarted && event.type === "agent_start") {
        sessionStarted = true;
        emit(session, { type: "session_start" });
      }

      if (session.currentMessageId === undefined) {
        flushBuffers(); // flush any leftover from a turn that ended without agent_end
        session.currentMessageId = session.messageIds.shift();
      }

      if (event.type === "message_update") {
        const ae = event.assistantMessageEvent;
        if (ae.type === "text_delta") {
          if (thinkingBuf) flushThinking();
          textBuf += ae.delta;
        } else if (ae.type === "thinking_delta") {
          if (textBuf) flushText();
          thinkingBuf += ae.delta;
        }
      }

      if (event.type === "tool_execution_start") {
        flushBuffers();
        toolArgs.set(event.toolCallId, event.args);
        emit(session, {
          type: "tool_use",
          content: JSON.stringify(event.args),
          metadata: { name: event.toolName, id: event.toolCallId },
        });
      }

      if (event.type === "tool_execution_end") {
        const output =
          typeof event.result === "string" ? event.result : JSON.stringify(event.result);
        emit(session, {
          type: "tool_result",
          content: output,
          metadata: {
            name: event.toolName,
            is_error: event.isError,
            tool_use_id: event.toolCallId,
          },
        });

        // Auto-commit file changes in home/, and notice edits to the mind's own identity.
        if ((event.toolName === "edit" || event.toolName === "write") && !event.isError) {
          const args = toolArgs.get(event.toolCallId);
          const filePath = typeof args?.path === "string" ? args.path : undefined;
          if (filePath) {
            trackFileChange(filePath, options.cwd);
            options.identityWatch?.noteFileChange(filePath);
          }
        }
        toolArgs.delete(event.toolCallId);
      }

      if (event.type === "agent_end") {
        flushBuffers();
        // Capture the turn's message context before clearing it: the ordered error/done
        // emits below run asynchronously, but currentMessageId must be reset synchronously
        // so the next turn shifts a fresh id (see the currentMessageId guard above).
        const messageId = session.currentMessageId;
        const channel = messageId ? session.messageChannels.get(messageId)?.channel : undefined;
        if (messageId) {
          session.messageChannels.delete(messageId);
        }
        // pi's agent loop drains every queued prompt (follow-ups, steers) before
        // a final agent_end, so anything still pending here was consumed by this
        // turn. Prune it all — a stranded id would be shifted in as the NEXT
        // turn's id, tagging that turn's rows with the wrong channel (#700).
        // Exception: on a retryable error the loop emits agent_end WITHOUT
        // draining and the session retries — those queued prompts haven't run
        // yet, so they keep their entries for the continuation.
        if (!event.willRetry) {
          session.messageIds.length = 0;
          session.messageChannels.clear();
        }
        log("mind", `session "${session.name}": turn done`);
        // Collect any agent-level errors (e.g. a provider 401 reported inside agent_end).
        // Warn-logging alone left the failure invisible at every host surface (#619);
        // we emit a turn_error to the daemon too — mirroring the dispatch-rejection path in
        // agent.ts — so classify() tags it and chat status + lastError surface it. Dedupe
        // identical messages so a turn with several failed messages records one notice.
        const errorMessages: string[] = [];
        if (event.messages) {
          const seen = new Set<string>();
          for (const msg of event.messages as AgentEndMessage[]) {
            if (msg.errorMessage && !seen.has(msg.errorMessage)) {
              seen.add(msg.errorMessage);
              warn("mind", `session "${session.name}": agent error: ${msg.errorMessage}`);
              errorMessages.push(msg.errorMessage);
            }
          }
        }
        // Sum usage from assistant messages. The last assistant message's input tokens
        // approximate current context size (it includes the full conversation up to that point).
        // The aggregate is the main loop's own; the last assistant message names its model.
        const own = sumAssistantUsage(event.messages);
        const subagents = session.subagentUsage?.splice(0) ?? [];
        const mainModel = own.model ?? options.mainModel;
        if (hasTokens(own) || subagents.length > 0) {
          const usage = {
            input_tokens: own.input,
            output_tokens: own.output,
            cache_read_input_tokens: own.cacheRead,
            cache_creation_input_tokens: own.cacheWrite,
            // Undefined until a message reports the split: absent, the daemon prices every
            // write at the catalog's 5-minute rate, which is pi-ai's default retention.
            ...(own.cacheWrite1h !== undefined && {
              cache_creation_1h_input_tokens: own.cacheWrite1h,
            }),
            model: mainModel,
            // Subagents ran this turn: send a per-model breakdown the daemon prices slice
            // by slice, with `main_model` naming the main loop's slice (the 1-hour writes
            // are its own). The main slice is always present, even at zero, so main_model
            // always matches one and every subagent slice is priced — without this their
            // spend would never reach the cap.
            ...(subagents.length > 0 &&
              mainModel && {
                models: mergeSlices([usageSlice(own, mainModel), ...subagents]),
                main_model: mainModel,
              }),
          };
          options.broadcast({ type: "usage", ...usage });
          emit(session, { type: "usage", metadata: usage });
        }
        if (own.lastContext > 0) {
          options.onContextTokens?.(own.lastContext);
        }
        options.broadcast({ type: "done" });
        session.currentMessageId = undefined;
        // Emit any errors BEFORE done, awaiting each in turn. daemonEmit is fire-and-forget,
        // so without ordered awaits the daemon could process `done` before `error`:
        // markErrored would land after done consumed the errored flag, leaking it into the
        // next turn (whose clean done then wrongly skips clearing delivered notices). This
        // mirrors agent.ts's awaited error-then-done ordering. Message context is captured
        // above rather than read from the (now-cleared) session.
        void (async () => {
          for (const content of errorMessages) {
            const ev = filterEvent(preset, {
              type: "error",
              session: session.name,
              channel,
              messageId,
              content,
            });
            if (ev) await daemonEmit(ev);
          }
          const doneEv = filterEvent(preset, {
            type: "done",
            session: session.name,
            channel,
            messageId,
          });
          if (doneEv) await daemonEmit(doneEv);
        })().catch((err) =>
          warn("mind", `session "${session.name}": error/done emit failed:`, err),
        );
        const willRetry = event.willRetry;
        flushFileChanges(options.cwd)
          .then(async () => {
            const rotated = options.onTurnEnd?.();
            // Commits are flushed and the turn has settled: if it rewrote an identity
            // file, ask for the restart that makes the new system prompt real. Latched
            // to once per process, so a refused restart doesn't retry every turn.
            //
            // Not on a retry (the queued prompts this agent_end preserved haven't run —
            // restarting now would drop the sender's message) and not on a rotation (the
            // restart would land on top of a session we just rewrote in place). Neither
            // drains the latch, so the reload fires at the end of the next settled turn.
            if (willRetry || rotated) return;
            if (options.identityWatch?.shouldRequestReload()) {
              await options.onIdentityReload?.();
            }
          })
          .catch((err) => log("mind", `session "${session.name}": flush/turn-end error:`, err));
      }
    } catch (err) {
      // warn-level: this block now drives turn-completion (error/done emission), so a throw
      // here can hang a turn — it must not be buried at debug level.
      warn("mind", `session "${session.name}": event handler error (${event?.type}):`, err);
    }
  };
}
