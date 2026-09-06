/**
 * Has the daemon begun shutting down?
 *
 * `shutdown()` stops the scheduler, sleep manager and delivery in its first few
 * synchronous lines, but `manager.stopAll()` — reaping live SDK subprocesses —
 * can take tens of seconds after that. The daemon keeps listening throughout, so
 * that minds' own shutdown writes land; the cost is that its HTTP surface used to
 * be indistinguishable from a live daemon's for that whole window. `/api/health`
 * answered ok, so `volute restart`'s health poll could be satisfied by the
 * *outgoing* daemon while the incoming one had already lost the port bind, and
 * `POST /:name/start` would spawn a mind nothing was left to supervise (#893).
 *
 * This lives in its own module, rather than as a field on a manager, because its
 * readers are HTTP handlers — one of them unauthenticated — that have no handle
 * on the daemon's own locals.
 */
let shuttingDown = false;

export function beginShutdown(): void {
  shuttingDown = true;
}

export function isShuttingDown(): boolean {
  return shuttingDown;
}

/** Test-only: the flag is process-global, so one test's shutdown would leak into the next. */
export function resetShutdownState(): void {
  shuttingDown = false;
}
