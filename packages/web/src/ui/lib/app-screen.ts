/** Top-level screen the app shows, based on setup + auth + connection state. */
export type AppScreen = "loading" | "setup" | "connection" | "login" | "app";

export type AppScreenState = {
  /** True once the initial auth/setup check has resolved. */
  checked: boolean;
  /** True when setup has been fully completed. */
  setupComplete: boolean;
  /** True when an admin account already exists (mid-setup or after). */
  hasAccount: boolean;
  /** True when no daemon connection is configured (remote flow). */
  needsConnection: boolean;
  /** True when this browser has an authenticated session. */
  loggedIn: boolean;
};

/**
 * Decide which top-level screen to render.
 *
 * The subtle case is a setup wizard resumed in a browser that lacks a session
 * (a different browser, or after the cookie expired). Setup is incomplete, so
 * we'd normally show the wizard — but the steps past account creation call
 * admin-gated endpoints, so an unauthenticated browser would dead-end on 401s.
 * When an account already exists but this browser isn't authenticated, route to
 * login first; setup resumes once `loggedIn` flips true.
 *
 * `loggedIn` is any authenticated session, not specifically an admin one. That's
 * fine here: the only account that can exist mid-setup is the first user, who is
 * auto-admin — additional (non-admin) users can only be created once setup is
 * complete — so a non-admin session at this point is effectively unreachable.
 */
export function resolveScreen(state: AppScreenState): AppScreen {
  if (!state.checked) return "loading";
  const needsLoginBeforeSetup = state.hasAccount && !state.loggedIn;
  if (!state.setupComplete && !needsLoginBeforeSetup) return "setup";
  if (state.needsConnection) return "connection";
  if (!state.loggedIn) return "login";
  return "app";
}
