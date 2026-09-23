/**
 * Thrown when a daemon manager (MindManager, DeliveryManager, Scheduler, …) is asked
 * for before its `init*()` has run.
 *
 * The HTTP server binds early in `startDaemon()` — deliberately, so `/api/health`
 * answers within seconds — while the managers initialise after the slow skill sync.
 * A request landing in that window is *early*, not broken, and the web layer turns
 * this into `503 {"error":"starting"}` instead of an unhandled 500 (#1050, #1067).
 * Callers that tolerate an absent manager should match this class, not the message.
 */
export class ManagerNotReadyError extends Error {
  constructor(manager: string, initFn: string) {
    super(`${manager} not initialized — call ${initFn}() first`);
    this.name = "ManagerNotReadyError";
  }
}
