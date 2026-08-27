import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AuthEvent, AuthPrompt } from "@earendil-works/pi-ai";
import { providerOAuth } from "../packages/daemon/src/lib/ai-service.js";
import { answerAuthPrompt, selectLoginMethod } from "../packages/daemon/src/web/api/system.js";

describe("selectLoginMethod", () => {
  it("picks the first offered option", async () => {
    const choice = await selectLoginMethod({
      options: [
        { id: "browser", label: "Browser login (default)" },
        { id: "device_code", label: "Device code login (headless)" },
      ],
    });
    assert.equal(choice, "browser");
  });

  it("throws rather than answering an empty option list", async () => {
    // pi-ai's prompt() must resolve with a string or reject. Resolving "" here
    // would push the failure down into the provider, where it surfaces as a blank
    // OAuth modal instead of an error the admin can read.
    await assert.rejects(selectLoginMethod({ options: [] }), /no method to select/);
  });

  it("answers a free-text prompt blank instead of asking for a paste", async () => {
    // Regression: GitHub Copilot opens its login with prompt({type:"text"}) asking for
    // an Enterprise domain, "blank for github.com", BEFORE it announces anything. The
    // migration to pi-ai 0.84's AuthInteraction briefly treated every non-select prompt
    // as "paste a code", which parked that login forever: the UI only renders its paste
    // box once a URL exists, and the answer we need is empty, which the code endpoint
    // rejects (min(1)). A text prompt must be answered empty, never parked.
    let codeRequested = false;
    const answer = await answerAuthPrompt(
      { type: "text", message: "GitHub Enterprise URL/domain (blank for github.com)" },
      async () => {
        codeRequested = true;
        return "should-not-be-used";
      },
    );
    assert.equal(answer, "");
    assert.equal(codeRequested, false, "a text prompt must not request a pasted code");
  });

  it("routes a manual_code prompt to the paste box", async () => {
    let codeRequested = false;
    const answer = await answerAuthPrompt(
      { type: "manual_code", message: "Paste the code" },
      async () => {
        codeRequested = true;
        return "pasted-code";
      },
    );
    assert.equal(answer, "pasted-code");
    assert.equal(codeRequested, true);
  });

  it("rejects a secret prompt rather than parking it on the paste box", async () => {
    // No catalog provider issues a `secret` prompt today, so nothing guarantees one
    // would arrive after an announcement — parking it would reproduce the Copilot
    // strand (spinner, no box). The paste box is also a cleartext field labelled
    // "paste the redirect URL", the wrong affordance for a secret. Fail readably.
    let codeRequested = false;
    await assert.rejects(
      answerAuthPrompt({ type: "secret", message: "Token" }, async () => {
        codeRequested = true;
        return "sekrit";
      }),
      /cannot collect safely/,
    );
    assert.equal(codeRequested, false, "a secret must not be routed to the paste box");
  });

  it("answers a select prompt without asking for a paste", async () => {
    let codeRequested = false;
    const answer = await answerAuthPrompt(
      {
        type: "select",
        message: "Select login method:",
        options: [{ id: "browser", label: "Browser" }],
      },
      async () => {
        codeRequested = true;
        return "nope";
      },
    );
    assert.equal(answer, "browser");
    assert.equal(codeRequested, false);
  });

  it("Copilot really does open with a free-text question before announcing anything", async () => {
    // The upstream fact the answerAuthPrompt policy above depends on. If pi-ai changes
    // copilot's login to announce first, or to ask something other than text, the
    // policy needs revisiting and this fails rather than the login silently hanging.
    // Regression: GitHub Copilot opens its login with prompt({type:"text"}) asking for
    // an Enterprise domain, "blank for github.com", BEFORE it announces anything. When
    // the migration to pi-ai 0.84's AuthInteraction treated every non-select prompt as
    // "paste a code", this parked the flow forever: the UI only renders its paste box
    // once a URL exists, and the answer we need is empty, which the code endpoint
    // rejects (min(1)). A text prompt must be answered empty, not parked.
    const oauth = providerOAuth("github-copilot");
    assert.ok(oauth, "github-copilot should offer OAuth in the builtin catalog");

    let asked: AuthPrompt | undefined;
    let announced = false;
    const stop = new Error("stop after the device flow starts");
    const realFetch = globalThis.fetch;
    // Fail the device-code request: we only care that the login got past the prompt.
    globalThis.fetch = (async () => {
      throw stop;
    }) as typeof fetch;
    try {
      await assert.rejects(
        oauth.login({
          signal: new AbortController().signal,
          notify: () => {
            announced = true;
          },
          prompt: async (prompt: AuthPrompt) => {
            asked = prompt;
            if (prompt.type === "select") return selectLoginMethod(prompt);
            if (prompt.type === "text") return "";
            throw new Error("a code paste must not be requested before anything is announced");
          },
        }),
      );
    } finally {
      globalThis.fetch = realFetch;
    }

    assert.equal(asked?.type, "text", "copilot should open with a free-text question");
    assert.equal(announced, false, "the question comes before any announcement");
  });

  it("answers the Codex login-method prompt so the flow reaches an auth URL", async () => {
    // Codex opens its login with a method selector. Cancelling there ends the login
    // before the auth URL is announced, which left the web UI with a blank OAuth
    // modal (no url, no error). Drive the real provider to prove we get past it.
    const oauth = providerOAuth("openai-codex");
    assert.ok(oauth, "openai-codex should offer OAuth in the builtin catalog");

    let authUrl = "";
    // Rejecting the manual-code input unwinds the login once we have what we need,
    // so the flow doesn't sit waiting on the local callback server.
    const cancelled = new Error("cancelled by test");

    await assert.rejects(
      oauth.login({
        signal: new AbortController().signal,
        notify: (event: AuthEvent) => {
          if (event.type === "auth_url") authUrl = event.url;
        },
        prompt: async (prompt: AuthPrompt) => {
          if (prompt.type === "select") return selectLoginMethod(prompt);
          throw cancelled;
        },
      }),
      (err: unknown) => err === cancelled,
    );

    assert.ok(
      authUrl.startsWith("https://auth.openai.com/oauth/authorize"),
      `expected an OpenAI authorize URL, got: ${authUrl || "(none)"}`,
    );
  });
});
