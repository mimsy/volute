import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type AppScreenState, resolveScreen } from "../packages/web/src/ui/lib/app-screen.js";

const base: AppScreenState = {
  checked: true,
  setupComplete: true,
  hasAccount: true,
  loadError: false,
  needsConnection: false,
  loggedIn: true,
};

describe("resolveScreen", () => {
  it("shows loading until the initial check resolves", () => {
    assert.equal(resolveScreen({ ...base, checked: false }), "loading");
  });

  it("shows the error screen when the setup/auth checks could not answer", () => {
    // A 502 on /setup/status or /auth/me leaves setupComplete/loggedIn at their
    // defaults. Routing on those defaults is the #724 bug — an unanswered check
    // must never resolve to a screen that claims to know the answer.
    assert.equal(resolveScreen({ ...base, loadError: true }), "error");
  });

  it("never routes to login on an unanswered check, whatever the defaults say", () => {
    // The poisonous shapes: optimistic setupComplete on a fresh install, and a
    // flaky /auth/me turning an authenticated admin into "logged out".
    for (const state of [
      { ...base, loadError: true, loggedIn: false },
      { ...base, loadError: true, setupComplete: false, hasAccount: true, loggedIn: false },
      { ...base, loadError: true, setupComplete: false, hasAccount: false, loggedIn: false },
    ]) {
      assert.equal(resolveScreen(state), "error");
    }
  });

  it("still shows loading before the first check resolves, error or not", () => {
    assert.equal(resolveScreen({ ...base, checked: false, loadError: true }), "loading");
  });

  it("shows the setup wizard at the very start (no system, no account)", () => {
    assert.equal(
      resolveScreen({ ...base, setupComplete: false, hasAccount: false, loggedIn: false }),
      "setup",
    );
  });

  it("resumes the setup wizard when mid-setup and still authenticated", () => {
    // Same browser: account exists, session intact — keep going in the wizard.
    assert.equal(
      resolveScreen({ ...base, setupComplete: false, hasAccount: true, loggedIn: true }),
      "setup",
    );
  });

  it("routes to login when setup is resumed without a session (the #690 bug)", () => {
    // A different browser (or expired cookie): the account exists but this
    // browser has no admin session. Provider/model fetches would 401 and the
    // wizard would dead-end — so send the user to log in first.
    assert.equal(
      resolveScreen({ ...base, setupComplete: false, hasAccount: true, loggedIn: false }),
      "login",
    );
  });

  it("shows the connection screen when no daemon connection is configured", () => {
    assert.equal(resolveScreen({ ...base, needsConnection: true, loggedIn: false }), "connection");
  });

  it("prefers connection over login when both apply mid-setup", () => {
    // Resumed without a session AND no daemon connection — the connection screen
    // wins, matching the original branch order (connection before login).
    assert.equal(
      resolveScreen({
        checked: true,
        setupComplete: false,
        hasAccount: true,
        loggedIn: false,
        needsConnection: true,
      }),
      "connection",
    );
  });

  it("prefers setup over connection on a fresh install", () => {
    // No account yet, so the login gate doesn't apply and the wizard shows even
    // if a connection isn't configured — setup comes before connection.
    assert.equal(
      resolveScreen({
        checked: true,
        setupComplete: false,
        hasAccount: false,
        loggedIn: false,
        needsConnection: true,
      }),
      "setup",
    );
  });

  it("shows login when setup is complete but the user is unauthenticated", () => {
    assert.equal(resolveScreen({ ...base, loggedIn: false }), "login");
  });

  it("shows the app when setup is complete and the user is authenticated", () => {
    assert.equal(resolveScreen(base), "app");
  });
});
