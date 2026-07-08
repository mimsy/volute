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
