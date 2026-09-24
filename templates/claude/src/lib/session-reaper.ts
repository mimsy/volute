/**
 * Idle-session reaping decision logic.
 *
 * Each mind session keeps a resident Claude SDK subprocess alive for as long as
 * the session lives. When a session has been idle past the configured timeout it
 * can be reaped — its subprocess shut down — while staying resumable, since the
 * session id is persisted and the next inbound message re-creates it via resume.
 */

export interface ReapableSession {
  name: string;
  /** Timestamp (ms) of the last inbound message or completed turn. */
  lastActivityAt: number;
  /** Set while a turn is in progress; undefined between turns. */
  currentMessageId?: string;
  channel: { isEmpty(): boolean };
}

/**
 * A session is reapable only when it has been idle longer than the timeout and
 * has no work in progress: no turn running, no queued/in-flight input, and not
 * mid-compaction (which owns its own abort/resume lifecycle).
 */
export function isSessionReapable(
  session: ReapableSession,
  now: number,
  idleTimeoutMs: number,
  isCompacting: (name: string) => boolean,
): boolean {
  if (idleTimeoutMs <= 0) return false;
  return (
    session.currentMessageId === undefined &&
    session.channel.isEmpty() &&
    !isCompacting(session.name) &&
    now - session.lastActivityAt > idleTimeoutMs
  );
}

/** Minimal view of the SDK query needed to shut its subprocess down. */
export interface ReapableQuery {
  /**
   * AsyncGenerator.return — the SDK overrides it to await its internal cleanup,
   * which waits (bounded) for the CLI subprocess to exit.
   */
  return(value?: unknown): Promise<unknown>;
}

/**
 * Tear down a reaped session's SDK subprocess and reap its exit status.
 *
 * `query.close()` is fire-and-forget: it kicks off cleanup but does not await the
 * CLI subprocess's exit, so the child is left `<defunct>` (a zombie) until the
 * mind process itself exits — PID-table growth on long-running minds with short
 * idle timeouts. `query.return()` awaits the SDK's cleanup, which waits for the
 * subprocess to exit, so the child's exit status is reaped. Errors are reported
 * via `onError` (never thrown) so a teardown failure can't wedge the reaper.
 */
export async function reapSessionQuery(
  query: ReapableQuery | undefined,
  onError: (err: unknown) => void,
): Promise<void> {
  if (!query) return;
  try {
    await query.return();
  } catch (err) {
    onError(err);
  }
}

/** Minimal view of a live session needed to tear it down on shutdown. */
export interface ShutdownReapable {
  name: string;
  /** Input iterable — closing it unwinds the stream consumer. */
  channel: { close(): void };
  /** The session's live SDK query, if it has one. */
  currentQuery?: ReapableQuery;
}

/**
 * Reap every live session's SDK subprocess on shutdown (SIGTERM/SIGINT).
 *
 * Unlike the idle reaper this ignores idle/reapable state — on the way out we
 * want *all* children gone. For each session it closes the input channel so the
 * stream consumer unwinds, then awaits `query.return()` so the CLI subprocess
 * exits and its status is reaped, rather than being orphaned to PID 1 (the
 * daemon, which doesn't reap reparented children) as a `<defunct>` zombie.
 * Reaps run in parallel; a per-session failure is reported via `onError` and
 * never rejects the batch, so one wedged child can't block the others.
 */
export async function reapSessionsForShutdown(
  sessions: Iterable<ShutdownReapable>,
  onError: (name: string, err: unknown) => void,
): Promise<void> {
  await Promise.all(
    [...sessions].map(async (s) => {
      s.channel.close();
      await reapSessionQuery(s.currentQuery, (err) => onError(s.name, err));
    }),
  );
}

/**
 * Default idle minutes before a persistent session is cold-reset: just inside the
 * prompt cache's 1h lifetime, past which the next turn rewrites the whole context
 * anyway — so that is the cheapest moment to rebuild it compactly (#1124).
 */
export const DEFAULT_COLD_RESET_MINUTES = 55;

/**
 * Whether a stored persistent session has been idle long enough to cold-reset:
 * archived like a rotation so its next turn starts from a fresh seed (recollection +
 * verbatim tail) instead of re-reading the whole cold context. Idle is measured from
 * the session's last turn end, persisted on its pointer. Ephemeral `new-*` sessions,
 * pointers that never carried a turn, and pointers with no recorded last turn never
 * reset; `coldResetMs <= 0` disables it, and so does `seedTokens <= 0` (seeding off).
 */
export function shouldColdReset(
  name: string,
  record: { committed: boolean; lastActivityAt?: number } | undefined,
  now: number,
  coldResetMs: number,
  seedTokens: number | undefined,
): boolean {
  if (!coldResetPossible(coldResetMs, seedTokens) || name.startsWith("new-")) return false;
  if (!record?.committed || record.lastActivityAt === undefined) return false;
  return now - record.lastActivityAt >= coldResetMs;
}

/**
 * Whether a cold reset can happen at all: enabled, and seeding on (no tail budget, no
 * seed to reset into — resetting would only cost context). `seedTokens` undefined is
 * the default budget.
 */
export function coldResetPossible(coldResetMs: number, seedTokens: number | undefined): boolean {
  return coldResetMs > 0 && (seedTokens === undefined || seedTokens > 0);
}

/**
 * The reaper's timeout. `idleMs <= 0` means never reap, and that holds: with reaping
 * off, a live session is never cold-reset (only one re-created after a restart is).
 * Otherwise the sooner of the idle and cold thresholds (`coldResetMs` 0 when a cold
 * reset can't happen), since the cold reset is decided when a session is next created
 * and a live one must leave the map by then.
 */
export function reapTimeoutMs(idleMs: number, coldResetMs: number): number {
  if (idleMs <= 0) return 0;
  return coldResetMs > 0 ? Math.min(idleMs, coldResetMs) : idleMs;
}

/**
 * Keeps a session's persisted last-activity time current for the cold reset. `touch`
 * records every bit of activity but writes at most once per `throttleMs` unless forced
 * (turn end), so a long tool loop keeps its pointer fresh without a write per step —
 * and a restart in the middle of a long turn never reads it as a quiet stretch.
 */
export function createActivityClock(
  persist: (at: number) => void,
  onError: (err: unknown) => void,
  throttleMs = 60_000,
) {
  let persistedAt = Number.NEGATIVE_INFINITY;
  return {
    touch(now: number, force = false): void {
      if (!force && now - persistedAt < throttleMs) return;
      // A failed timestamp write is only a stale idle clock — never a reason to fail
      // the turn that was recording it.
      try {
        persist(now);
        persistedAt = now;
      } catch (err) {
        onError(err);
      }
    },
  };
}

/**
 * Interrupt a session's current turn, if it has a live one. `currentQuery` is cleared
 * while a rotation or seed is between streams, so an interrupt arriving then is a
 * no-op rather than a call into a dead query; a rejection from the SDK is reported,
 * never left unhandled.
 */
export function interruptCurrentTurn(
  session: {
    currentMessageId?: string;
    currentQuery?: { interrupt(): Promise<unknown> };
  },
  onError: (err: unknown) => void,
): boolean {
  if (session.currentMessageId === undefined || !session.currentQuery) return false;
  session.currentQuery.interrupt().catch(onError);
  return true;
}
