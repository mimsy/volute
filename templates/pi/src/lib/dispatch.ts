import type { ImageContent } from "@earendil-works/pi-ai";

/** Options accepted by {@link PromptTarget.prompt}. Subset of pi's PromptOptions. */
export interface DispatchOptions {
  streamingBehavior?: "steer" | "followUp";
  images?: ImageContent[];
}

/** The slice of a pi AgentSession that {@link dispatchPrompt} needs. */
export interface PromptTarget {
  readonly isStreaming: boolean;
  prompt(text: string, options?: DispatchOptions): Promise<void>;
}

/**
 * True when `err` is pi's "agent is already processing" rejection — thrown when a
 * fresh (non-streaming) prompt is sent while a turn is actually in flight.
 */
export function isAlreadyProcessingError(err: unknown): boolean {
  return err instanceof Error && err.message.includes("already processing");
}

/**
 * Send `text` to the agent, choosing the right queueing behavior for burst delivery.
 *
 * `AgentSession.isStreaming` only flips to `true` partway through an in-flight
 * `prompt()` call, so a second message that arrives in the same tick can observe
 * `isStreaming === false`, take the fresh-prompt path, and race the first message.
 * pi rejects the loser with "agent is already processing". Awaiting the dispatch
 * (so the rejection is caught, not left floating as an unhandled rejection that
 * crashes the mind server) and re-routing the loser as a follow-up keeps both
 * messages: nothing is dropped, and the server survives.
 *
 * - Idle: fresh prompt. On the race rejection, re-route as a follow-up.
 * - Streaming + interrupt: steer the current turn (after `onInterrupt`).
 * - Streaming: queue as a follow-up to run after the current turn.
 */
export async function dispatchPrompt(
  agent: PromptTarget,
  text: string,
  opts: { images?: ImageContent[] },
  interrupt: boolean,
  onInterrupt: () => void,
): Promise<void> {
  if (agent.isStreaming) {
    if (interrupt) {
      onInterrupt();
      await agent.prompt(text, { streamingBehavior: "steer", ...opts });
    } else {
      await agent.prompt(text, { streamingBehavior: "followUp", ...opts });
    }
    return;
  }

  try {
    await agent.prompt(text, opts);
  } catch (err) {
    if (!isAlreadyProcessingError(err)) throw err;
    // Lost the race: another burst message started a turn between our isStreaming
    // check and this dispatch. Queue as a follow-up instead of crashing. If the
    // winning turn has already finished by now, pi only consults streamingBehavior
    // while streaming, so this is sent as a fresh prompt — delivered either way.
    await agent.prompt(text, { streamingBehavior: "followUp", ...opts });
  }
}
