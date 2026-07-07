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
