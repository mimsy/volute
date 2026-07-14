import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { readGlobalConfig, writeGlobalConfig } from "../packages/daemon/src/lib/config/setup.js";
import {
  getConfiguredProviders,
  getEnabledModels,
  parseModelId,
  removeProviderConfig,
  resolveCredential,
  saveProviderConfig,
  setEnabledModels,
} from "../packages/daemon/src/lib/services/imagegen.js";
import {
  accountIdFromToken,
  buildCodexRequest,
  CODEX_NOT_ENTITLED_SENTINEL,
  CodexNotEntitledError,
  codexGenerate,
  parseCodexImageStream,
} from "../packages/daemon/src/lib/services/imagegen-codex.js";
import {
  generateViaDaemon,
  handleDaemonFailure,
  searchViaDaemon,
} from "../skills/imagegen/scripts/imagegen.js";

/** Build a synthetic Codex OAuth access token (JWT) carrying an account id. */
function fakeCodexToken(accountId: string): string {
  const payload = Buffer.from(
    JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
  ).toString("base64url");
  return `header.${payload}.sig`;
}

/** Wrap SSE text as a byte ReadableStream, chunked to exercise the line buffer. */
function sseStream(text: string, chunkSize = 7): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i >= bytes.length) return controller.close();
      controller.enqueue(bytes.slice(i, i + chunkSize));
      i += chunkSize;
    },
  });
}

function resetImagegenConfig() {
  const config = readGlobalConfig();
  delete config.imagegen;
  delete config.ai;
  writeGlobalConfig(config);
}

describe("imagegen config", () => {
  afterEach(resetImagegenConfig);

  describe("saveProviderConfig / removeProviderConfig", () => {
    it("saves a provider API key to config", () => {
      saveProviderConfig("replicate", "test-key-123");
      const config = readGlobalConfig();
      assert.equal(config.imagegen?.providers?.replicate?.apiKey, "test-key-123");
    });

    it("saves an openrouter API key to config", () => {
      saveProviderConfig("openrouter", "or-key-456");
      const config = readGlobalConfig();
      assert.equal(config.imagegen?.providers?.openrouter?.apiKey, "or-key-456");
    });

    it("removes a provider config", () => {
      saveProviderConfig("replicate", "test-key");
      removeProviderConfig("replicate");
      const config = readGlobalConfig();
      assert.equal(config.imagegen?.providers, undefined);
    });

    it("removes openrouter config independently", () => {
      saveProviderConfig("replicate", "rep-key");
      saveProviderConfig("openrouter", "or-key");
      removeProviderConfig("openrouter");
      const config = readGlobalConfig();
      assert.equal(config.imagegen?.providers?.replicate?.apiKey, "rep-key");
      assert.equal(config.imagegen?.providers?.openrouter, undefined);
    });

    it("throws on unknown provider id", () => {
      assert.throws(
        () => saveProviderConfig("unknown-provider", "key"),
        /Unknown imagegen provider/,
      );
      assert.throws(() => removeProviderConfig("unknown-provider"), /Unknown imagegen provider/);
    });
  });

  describe("resolveCredential", () => {
    it("returns config key when set", async () => {
      saveProviderConfig("replicate", "config-key");
      assert.deepEqual(await resolveCredential("replicate"), {
        kind: "api_key",
        token: "config-key",
      });
    });

    it("falls back to env var when no config key", async () => {
      const original = process.env.REPLICATE_API_TOKEN;
      try {
        process.env.REPLICATE_API_TOKEN = "env-key";
        assert.equal((await resolveCredential("replicate"))?.token, "env-key");
      } finally {
        if (original !== undefined) {
          process.env.REPLICATE_API_TOKEN = original;
        } else {
          delete process.env.REPLICATE_API_TOKEN;
        }
      }
    });

    it("prefers config key over env var", async () => {
      const original = process.env.REPLICATE_API_TOKEN;
      try {
        process.env.REPLICATE_API_TOKEN = "env-key";
        saveProviderConfig("replicate", "config-key");
        assert.equal((await resolveCredential("replicate"))?.token, "config-key");
      } finally {
        if (original !== undefined) {
          process.env.REPLICATE_API_TOKEN = original;
        } else {
          delete process.env.REPLICATE_API_TOKEN;
        }
      }
    });

    it("returns undefined for unknown provider", async () => {
      assert.equal(await resolveCredential("nonexistent"), undefined);
    });

    it("returns undefined when nothing is configured", async () => {
      const original = process.env.REPLICATE_API_TOKEN;
      try {
        delete process.env.REPLICATE_API_TOKEN;
        assert.equal(await resolveCredential("replicate"), undefined);
      } finally {
        if (original !== undefined) {
          process.env.REPLICATE_API_TOKEN = original;
        } else {
          delete process.env.REPLICATE_API_TOKEN;
        }
      }
    });

    it("resolves openrouter env var", async () => {
      const original = process.env.OPENROUTER_API_KEY;
      try {
        process.env.OPENROUTER_API_KEY = "or-env-key";
        assert.equal((await resolveCredential("openrouter"))?.token, "or-env-key");
      } finally {
        if (original !== undefined) {
          process.env.OPENROUTER_API_KEY = original;
        } else {
          delete process.env.OPENROUTER_API_KEY;
        }
      }
    });

    it("falls back to AI provider config key", async () => {
      const config = readGlobalConfig();
      config.ai = { providers: { openrouter: { apiKey: "ai-provider-key" } } };
      writeGlobalConfig(config);
      assert.equal((await resolveCredential("openrouter"))?.token, "ai-provider-key");
    });

    it("prefers imagegen config key over AI provider key", async () => {
      const config = readGlobalConfig();
      config.ai = { providers: { openrouter: { apiKey: "ai-provider-key" } } };
      writeGlobalConfig(config);
      saveProviderConfig("openrouter", "imagegen-key");
      assert.equal((await resolveCredential("openrouter"))?.token, "imagegen-key");
    });

    it("resolves an oauth credential from the linked AI provider", async () => {
      // Far-future expiry ⇒ resolveOAuthCredentials returns the token with no
      // refresh/network call (see ai-service.test.ts).
      const config = readGlobalConfig();
      config.ai = {
        providers: {
          "openai-codex": {
            oauth: { access: "codex-access-token", refresh: "r", expires: 4102444800000 },
          },
        },
      };
      writeGlobalConfig(config);
      assert.deepEqual(await resolveCredential("openai-codex"), {
        kind: "oauth",
        token: "codex-access-token",
      });
    });
  });

  describe("getConfiguredProviders", () => {
    it("returns api_key auth when config key is set", () => {
      saveProviderConfig("replicate", "my-key");
      const providers = getConfiguredProviders();
      const replicate = providers.find((p) => p.id === "replicate");
      assert.ok(replicate);
      assert.equal(replicate.configured, true);
      assert.equal(replicate.authMethod, "api_key");
    });

    it("returns env_var auth when only env var is set", () => {
      const original = process.env.REPLICATE_API_TOKEN;
      try {
        process.env.REPLICATE_API_TOKEN = "env-key";
        const providers = getConfiguredProviders();
        const replicate = providers.find((p) => p.id === "replicate");
        assert.ok(replicate);
        assert.equal(replicate.configured, true);
        assert.equal(replicate.authMethod, "env_var");
      } finally {
        if (original !== undefined) {
          process.env.REPLICATE_API_TOKEN = original;
        } else {
          delete process.env.REPLICATE_API_TOKEN;
        }
      }
    });

    it("returns unconfigured when nothing is set", () => {
      const original = process.env.REPLICATE_API_TOKEN;
      try {
        delete process.env.REPLICATE_API_TOKEN;
        const providers = getConfiguredProviders();
        const replicate = providers.find((p) => p.id === "replicate");
        assert.ok(replicate);
        assert.equal(replicate.configured, false);
        assert.equal(replicate.authMethod, null);
      } finally {
        if (original !== undefined) {
          process.env.REPLICATE_API_TOKEN = original;
        } else {
          delete process.env.REPLICATE_API_TOKEN;
        }
      }
    });

    it("includes openrouter in provider list", () => {
      const providers = getConfiguredProviders();
      const openrouter = providers.find((p) => p.id === "openrouter");
      assert.ok(openrouter);
    });

    it("detects openrouter configured via AI provider config", () => {
      const config = readGlobalConfig();
      config.ai = { providers: { openrouter: { apiKey: "ai-key" } } };
      writeGlobalConfig(config);
      const providers = getConfiguredProviders();
      const openrouter = providers.find((p) => p.id === "openrouter");
      assert.ok(openrouter);
      assert.equal(openrouter.configured, true);
      assert.equal(openrouter.authMethod, "api_key");
    });

    it("auto-adds openai-codex when its AI provider has OAuth (chat/image unification)", () => {
      const config = readGlobalConfig();
      config.ai = {
        providers: {
          "openai-codex": { oauth: { access: "a", refresh: "r", expires: 4102444800000 } },
        },
      };
      writeGlobalConfig(config);
      const codex = getConfiguredProviders().find((p) => p.id === "openai-codex");
      assert.ok(codex);
      assert.equal(codex.configured, true);
      assert.equal(codex.authMethod, "oauth");
    });

    it("reports openai-codex unconfigured when its AI provider is absent", () => {
      const codex = getConfiguredProviders().find((p) => p.id === "openai-codex");
      assert.ok(codex);
      assert.equal(codex.configured, false);
      assert.equal(codex.authMethod, null);
    });
  });

  describe("getEnabledModels / setEnabledModels", () => {
    it("returns empty array when no models configured", () => {
      assert.deepEqual(getEnabledModels(), []);
    });

    it("saves and retrieves enabled models", () => {
      setEnabledModels(["replicate:owner/model-a", "openrouter:owner/model-b"]);
      assert.deepEqual(getEnabledModels(), ["replicate:owner/model-a", "openrouter:owner/model-b"]);
    });

    it("overwrites previous models", () => {
      setEnabledModels(["replicate:owner/model-a"]);
      setEnabledModels(["openrouter:owner/model-b"]);
      assert.deepEqual(getEnabledModels(), ["openrouter:owner/model-b"]);
    });
  });

  describe("parseModelId", () => {
    it("parses valid replicate model ID", () => {
      const result = parseModelId("replicate:owner/model-name");
      assert.deepEqual(result, { provider: "replicate", model: "owner/model-name" });
    });

    it("parses valid openrouter model ID", () => {
      const result = parseModelId("openrouter:openai/gpt-image-1");
      assert.deepEqual(result, { provider: "openrouter", model: "openai/gpt-image-1" });
    });

    it("throws on missing prefix", () => {
      assert.throws(() => parseModelId("owner/model-name"), /must be provider-prefixed/);
    });

    it("throws on unknown provider", () => {
      assert.throws(() => parseModelId("badprovider:owner/model"), /Unknown imagegen provider/);
    });
  });
});

describe("imagegen openai-codex provider", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  // A 1x1 red PNG, base64 — stands in for a generated image.
  const PNG_B64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

  it("accountIdFromToken reads the chatgpt_account_id JWT claim", () => {
    assert.equal(accountIdFromToken(fakeCodexToken("acct-xyz")), "acct-xyz");
  });

  it("accountIdFromToken returns undefined for a non-JWT token", () => {
    assert.equal(accountIdFromToken("not-a-jwt"), undefined);
  });

  it("buildCodexRequest forces the hosted image tool with the given model", () => {
    const req = buildCodexRequest("gpt-image-2", "a cat") as {
      tools: Array<{ type: string; model: string }>;
      tool_choice: { type: string };
      stream: boolean;
    };
    assert.equal(req.tools[0].type, "image_generation");
    assert.equal(req.tools[0].model, "gpt-image-2");
    assert.equal(req.tool_choice.type, "image_generation");
    assert.equal(req.stream, true);
  });

  it("parseCodexImageStream extracts the largest base64 blob from the stream", async () => {
    const sse = [
      "event: response.created",
      'data: {"type":"response.created","response":{"id":"r"}}',
      "",
      "event: response.image_generation_call.partial_image",
      `data: {"type":"response.image_generation_call.partial_image","partial_image_b64":"${PNG_B64}"}`,
      "",
      "event: response.completed",
      'data: {"type":"response.completed","response":{"output":[]}}',
      "",
    ].join("\n");
    const buf = await parseCodexImageStream(sseStream(sse));
    assert.deepEqual(buf, Buffer.from(PNG_B64, "base64"));
    // PNG magic bytes survived the round-trip.
    assert.equal(buf.subarray(1, 4).toString(), "PNG");
  });

  it("codexGenerate posts to the Codex backend and returns image bytes", async () => {
    let seen: { url: string; auth?: string; account?: string } | undefined;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      seen = {
        url: String(url),
        auth: headers.get("authorization") ?? undefined,
        account: headers.get("chatgpt-account-id") ?? undefined,
      };
      const sse =
        "event: response.image_generation_call.partial_image\n" +
        `data: {"type":"response.image_generation_call.partial_image","partial_image_b64":"${PNG_B64}"}\n\n`;
      return new Response(sseStream(sse), { status: 200 });
    }) as typeof fetch;

    const buf = await codexGenerate("gpt-image-2", "a dog", {
      kind: "oauth",
      token: fakeCodexToken("acct-42"),
    });
    assert.deepEqual(buf, Buffer.from(PNG_B64, "base64"));
    assert.ok(seen);
    assert.match(seen.url, /chatgpt\.com\/backend-api\/codex\/responses$/);
    assert.match(seen.auth ?? "", /^Bearer /);
    assert.equal(seen.account, "acct-42", "account id must come from the token JWT");
  });

  it("codexGenerate throws CodexNotEntitledError on the exact 400 sentinel", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ detail: CODEX_NOT_ENTITLED_SENTINEL }), {
        status: 400,
      })) as typeof fetch;
    await assert.rejects(
      codexGenerate("gpt-image-2", "x", { kind: "oauth", token: fakeCodexToken("a") }),
      (err: Error) => err instanceof CodexNotEntitledError,
    );
  });

  it("codexGenerate throws a generic error on other failures", async () => {
    globalThis.fetch = (async () => new Response("upstream boom", { status: 502 })) as typeof fetch;
    await assert.rejects(
      codexGenerate("gpt-image-2", "x", { kind: "oauth", token: fakeCodexToken("a") }),
      /502/,
    );
  });
});

describe("imagegen skill daemon error reporting", () => {
  const realFetch = globalThis.fetch;
  const savedEnv = {
    port: process.env.VOLUTE_DAEMON_PORT,
    token: process.env.VOLUTE_MIND_TOKEN,
  };

  function setDaemonEnv(present: boolean) {
    if (present) {
      process.env.VOLUTE_DAEMON_PORT = "1618";
      process.env.VOLUTE_MIND_TOKEN = "mind-token";
    } else {
      delete process.env.VOLUTE_DAEMON_PORT;
      delete process.env.VOLUTE_MIND_TOKEN;
    }
  }

  function mockFetch(fn: () => Promise<Response> | Response) {
    globalThis.fetch = (async () => fn()) as typeof fetch;
  }

  function jsonResponse(status: number, body: unknown): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      arrayBuffer: async () => new ArrayBuffer(0),
    } as unknown as Response;
  }

  afterEach(() => {
    globalThis.fetch = realFetch;
    if (savedEnv.port !== undefined) process.env.VOLUTE_DAEMON_PORT = savedEnv.port;
    else delete process.env.VOLUTE_DAEMON_PORT;
    if (savedEnv.token !== undefined) process.env.VOLUTE_MIND_TOKEN = savedEnv.token;
    else delete process.env.VOLUTE_MIND_TOKEN;
  });

  describe("generateViaDaemon", () => {
    it("reports no-env when daemon env vars are unset", async () => {
      setDaemonEnv(false);
      const res = await generateViaDaemon("replicate:owner/model", "prompt");
      assert.deepEqual(res, { ok: false, reason: "no-env" });
    });

    it("reports unreachable when the connection fails", async () => {
      setDaemonEnv(true);
      mockFetch(() => {
        throw new TypeError("fetch failed");
      });
      const res = await generateViaDaemon("replicate:owner/model", "prompt");
      assert.equal(res.ok, false);
      assert.equal(res.ok === false && res.reason, "unreachable");
    });

    it("reports auth failure on 401", async () => {
      setDaemonEnv(true);
      mockFetch(() => jsonResponse(401, { error: "invalid token" }));
      const res = await generateViaDaemon("replicate:owner/model", "prompt");
      assert.equal(res.ok, false);
      assert.equal(res.ok === false && res.reason, "auth");
      assert.equal(res.ok === false && res.reason === "auth" && res.status, 401);
    });

    it("reports auth failure on 403", async () => {
      setDaemonEnv(true);
      mockFetch(() => jsonResponse(403, { error: "forbidden" }));
      const res = await generateViaDaemon("replicate:owner/model", "prompt");
      assert.equal(res.ok === false && res.reason, "auth");
    });

    it("reports fallback when imagegen is genuinely not configured", async () => {
      setDaemonEnv(true);
      mockFetch(() => jsonResponse(400, { error: "imagegen not configured" }));
      const res = await generateViaDaemon("replicate:owner/model", "prompt");
      assert.deepEqual(res, { ok: false, reason: "fallback" });
    });

    it("throws on an unexpected daemon error", async () => {
      setDaemonEnv(true);
      mockFetch(() => jsonResponse(500, { error: "boom" }));
      await assert.rejects(generateViaDaemon("replicate:owner/model", "prompt"), /boom/);
    });

    it("returns the image buffer on success", async () => {
      setDaemonEnv(true);
      mockFetch(() => jsonResponse(200, {}));
      const res = await generateViaDaemon("replicate:owner/model", "prompt");
      assert.equal(res.ok, true);
      assert.ok(res.ok && Buffer.isBuffer(res.value));
    });
  });

  describe("searchViaDaemon", () => {
    it("reports no-env when daemon env vars are unset", async () => {
      setDaemonEnv(false);
      const res = await searchViaDaemon("query");
      assert.deepEqual(res, { ok: false, reason: "no-env" });
    });

    it("reports auth failure on 401", async () => {
      setDaemonEnv(true);
      mockFetch(() => jsonResponse(401, { error: "invalid token" }));
      const res = await searchViaDaemon("query");
      assert.equal(res.ok === false && res.reason, "auth");
    });

    it("reports fallback for older daemon without the endpoint (404)", async () => {
      setDaemonEnv(true);
      mockFetch(() => jsonResponse(404, { error: "not found" }));
      const res = await searchViaDaemon("query");
      assert.deepEqual(res, { ok: false, reason: "fallback" });
    });

    it("returns results on success", async () => {
      setDaemonEnv(true);
      mockFetch(() => jsonResponse(200, [{ id: "replicate:owner/model" }]));
      const res = await searchViaDaemon("query");
      assert.equal(res.ok, true);
      assert.deepEqual(res.ok && res.value, [{ id: "replicate:owner/model" }]);
    });
  });

  describe("handleDaemonFailure", () => {
    it("returns (falls back) for no-env", () => {
      assert.doesNotThrow(() => handleDaemonFailure({ ok: false, reason: "no-env" }));
    });

    it("returns (falls back) for fallback", () => {
      assert.doesNotThrow(() => handleDaemonFailure({ ok: false, reason: "fallback" }));
    });

    it("throws a connection diagnosis for unreachable, not a config one", () => {
      assert.throws(
        () => handleDaemonFailure({ ok: false, reason: "unreachable", detail: "fetch failed" }),
        /not a provider-configuration issue/,
      );
    });

    it("throws an auth diagnosis for auth, not a config one", () => {
      assert.throws(
        () => handleDaemonFailure({ ok: false, reason: "auth", status: 401, detail: "bad token" }),
        /authentication problem/,
      );
    });
  });
});
