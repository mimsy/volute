import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getOAuthProvider } from "@earendil-works/pi-ai/oauth";
import { selectLoginMethod } from "../packages/daemon/src/web/api/system.js";

describe("selectLoginMethod", () => {
  it("picks the first offered option", async () => {
    const choice = await selectLoginMethod({
      message: "Select login method:",
      options: [
        { id: "browser", label: "Browser login (default)" },
        { id: "device_code", label: "Device code login (headless)" },
      ],
    });
    assert.equal(choice, "browser");
  });

  it("answers the Codex login-method prompt so the flow reaches an auth URL", async () => {
    // Codex opens its login with a method selector. Answering `undefined` there
    // cancels the login before onAuth fires, which left the web UI with a blank
    // OAuth modal (no url, no error). Drive the real provider to prove we get past it.
    const provider = getOAuthProvider("openai-codex");
    assert.ok(provider, "openai-codex OAuth provider should be registered");

    let authUrl = "";
    // Rejecting the manual-code input unwinds the login once we have what we need,
    // so the flow doesn't sit waiting on the local callback server.
    const cancelled = new Error("cancelled by test");

    await assert.rejects(
      provider.login({
        onAuth: (info) => {
          authUrl = info.url;
        },
        onDeviceCode: () => {},
        onPrompt: async () => {
          throw cancelled;
        },
        onManualCodeInput: async () => {
          throw cancelled;
        },
        onSelect: selectLoginMethod,
      }),
      (err: unknown) => err === cancelled,
    );

    assert.ok(
      authUrl.startsWith("https://auth.openai.com/oauth/authorize"),
      `expected an OpenAI authorize URL, got: ${authUrl || "(none)"}`,
    );
  });
});
