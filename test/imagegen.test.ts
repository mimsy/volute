import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { OAuthRefreshError } from "../packages/daemon/src/lib/ai-service.js";
import {
  isImagegenEnabled,
  readGlobalConfig,
  writeGlobalConfig,
} from "../packages/daemon/src/lib/config/setup.js";
import {
  registerXaiOAuthProvider,
  validateXaiUrl,
  xaiOAuthProvider,
} from "../packages/daemon/src/lib/oauth/xai.js";
import {
  generateImage,
  getConfiguredProviders,
  getEnabledModels,
  getEntitlement,
  parseModelId,
  probeEntitlement,
  removeProviderConfig,
  resolveCredential,
  saveProviderConfig,
  searchModels,
  setEnabledModels,
} from "../packages/daemon/src/lib/services/imagegen.js";
import {
  accountIdFromToken,
  buildCodexRequest,
  CODEX_NOT_ENTITLED_SENTINEL,
  CodexNotEntitledError,
  codexGenerate,
  parseCodexImageStream,
  probeCodexEntitlement,
} from "../packages/daemon/src/lib/services/imagegen-codex.js";
import {
  _resetImagegenJobs,
  createImagegenJob,
  getImagegenJob,
  waitForImagegenJob,
} from "../packages/daemon/src/lib/services/imagegen-jobs.js";
import {
  XaiNotEntitledError,
  xaiApiKeyFallback,
  xaiGenerate,
} from "../packages/daemon/src/lib/services/imagegen-xai.js";
import {
  handleDaemonFailure,
  pollImagegenJob,
  searchViaDaemon,
  startImagegenJob,
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

    it("throws OAuthRefreshError (not undefined) when a subscription-only provider's OAuth refresh fails", async () => {
      // openai-codex is subscription-only: OAuth is the only credential path.
      // A transient refresh failure must surface as a distinct error, not fall
      // through to undefined (which callers report as "not configured").
      const realFetch = globalThis.fetch;
      globalThis.fetch = (async () => {
        throw new TypeError("token endpoint unreachable");
      }) as typeof fetch;
      try {
        const config = readGlobalConfig();
        config.ai = {
          providers: {
            "openai-codex": { oauth: { access: "expired", refresh: "r", expires: 0 } },
          },
        };
        writeGlobalConfig(config);
        await assert.rejects(resolveCredential("openai-codex"), (err: unknown) => {
          assert.ok(err instanceof OAuthRefreshError, "should be an OAuthRefreshError");
          assert.doesNotMatch(err.message, /not configured/i);
          return true;
        });
      } finally {
        globalThis.fetch = realFetch;
      }
    });

    it("falls back to the AI provider's API key when OAuth refresh fails", async () => {
      // A provider that has BOTH a (failing) OAuth grant and a static API key
      // must degrade to the key during a transient auth blip, not error out.
      const realFetch = globalThis.fetch;
      globalThis.fetch = (async () => {
        throw new TypeError("token endpoint unreachable");
      }) as typeof fetch;
      try {
        const config = readGlobalConfig();
        config.ai = {
          providers: {
            "openai-codex": {
              oauth: { access: "expired", refresh: "r", expires: 0 },
              apiKey: "codex-fallback-key",
            },
          },
        };
        writeGlobalConfig(config);
        assert.deepEqual(await resolveCredential("openai-codex"), {
          kind: "api_key",
          token: "codex-fallback-key",
        });
      } finally {
        globalThis.fetch = realFetch;
      }
    });

    it("still returns undefined when a provider genuinely has no credentials", async () => {
      // No OAuth, no key, no env — the unchanged "not configured" path.
      assert.equal(await resolveCredential("openai-codex"), undefined);
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

  describe("isImagegenEnabled", () => {
    it("is false with no imagegen or ai config", () => {
      assert.equal(isImagegenEnabled(), false);
    });

    it("is true when an imagegen provider key is configured", () => {
      saveProviderConfig("replicate", "key");
      assert.equal(isImagegenEnabled(), true);
    });

    it("is true when only a subscription AI provider (codex) is configured for chat", () => {
      const config = readGlobalConfig();
      config.ai = {
        providers: {
          "openai-codex": { oauth: { access: "a", refresh: "r", expires: 4102444800000 } },
        },
      };
      writeGlobalConfig(config);
      assert.equal(isImagegenEnabled(), true, "codex chat provider auto-enables imagegen");
    });

    it("is false when only a non-imagegen AI provider (anthropic) is configured", () => {
      const config = readGlobalConfig();
      config.ai = { providers: { anthropic: { apiKey: "sk-ant" } } };
      writeGlobalConfig(config);
      assert.equal(isImagegenEnabled(), false);
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

  it("parseCodexImageStream rejects a stream that closes before completion", async () => {
    // A partial image arrived but the stream ended without response.completed —
    // must throw rather than silently return the low-res partial as the final image.
    const sse = [
      "event: response.image_generation_call.partial_image",
      `data: {"type":"response.image_generation_call.partial_image","partial_image_b64":"${PNG_B64}"}`,
      "",
    ].join("\n");
    await assert.rejects(parseCodexImageStream(sseStream(sse)), /before completion/);
  });

  it("probeCodexEntitlement returns entitled once the tool starts, then aborts", async () => {
    let aborted = false;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      init.signal?.addEventListener("abort", () => {
        aborted = true;
      });
      const sse =
        'data: {"type":"response.created"}\n\n' +
        'data: {"type":"response.image_generation_call.in_progress"}\n\n';
      return new Response(sseStream(sse), { status: 200 });
    }) as typeof fetch;
    const state = await probeCodexEntitlement({ kind: "oauth", token: fakeCodexToken("a") });
    assert.equal(state, "entitled");
    assert.ok(aborted, "the stream should be aborted once entitlement is known");
  });

  it("probeCodexEntitlement returns not_entitled on the 400 sentinel", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ detail: CODEX_NOT_ENTITLED_SENTINEL }), {
        status: 400,
      })) as typeof fetch;
    const state = await probeCodexEntitlement({ kind: "oauth", token: fakeCodexToken("a") });
    assert.equal(state, "not_entitled");
  });

  it("probeCodexEntitlement returns not_entitled when the tool never starts", async () => {
    globalThis.fetch = (async () =>
      new Response(sseStream('data: {"type":"response.completed"}\n\n'), {
        status: 200,
      })) as typeof fetch;
    const state = await probeCodexEntitlement({ kind: "oauth", token: fakeCodexToken("a") });
    assert.equal(state, "not_entitled");
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
        `data: {"type":"response.image_generation_call.partial_image","partial_image_b64":"${PNG_B64}"}\n\n` +
        'data: {"type":"response.completed","response":{"output":[]}}\n\n';
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

describe("imagegen jobs", () => {
  // Uses a provider with no configured credentials, so generateImage rejects
  // fast (no network) and each job settles to "error" — enough to exercise the
  // lifecycle, ownership, and cap without a real provider.
  const UNCONFIGURED_MODEL = "openai-codex:gpt-image-2";

  afterEach(() => {
    _resetImagegenJobs();
    const config = readGlobalConfig();
    delete config.imagegen;
    delete config.ai;
    writeGlobalConfig(config);
  });

  it("creates a job and returns an id", () => {
    const id = createImagegenJob("mind-a", UNCONFIGURED_MODEL, "prompt", "file");
    assert.equal(typeof id, "string");
    assert.ok(id.length > 0);
  });

  it("a job settles to error when generation fails", async () => {
    const id = createImagegenJob("mind-a", UNCONFIGURED_MODEL, "prompt", "file");
    const job = await waitForImagegenJob("mind-a", id, 5000);
    assert.ok(job);
    assert.equal(job.status, "error");
    assert.match(job.error ?? "", /credentials|No .* configured/i);
  });

  it("enforces per-mind ownership", () => {
    const id = createImagegenJob("mind-a", UNCONFIGURED_MODEL, "prompt", "file");
    assert.ok(getImagegenJob("mind-a", id), "owner can read its job");
    assert.equal(getImagegenJob("mind-b", id), undefined, "another mind cannot read it");
  });

  it("returns undefined for an unknown job", () => {
    assert.equal(getImagegenJob("mind-a", "no-such-job"), undefined);
  });

  it("caps in-flight jobs per mind", () => {
    // createImagegenJob is synchronous and marks the job running before the
    // async generation yields, so four synchronous creates fill the cap and the
    // fifth throws — deterministically, before any settles.
    for (let i = 0; i < 4; i++) createImagegenJob("mind-cap", UNCONFIGURED_MODEL, "p", `f${i}`);
    assert.throws(
      () => createImagegenJob("mind-cap", UNCONFIGURED_MODEL, "p", "f5"),
      /Too many image generations/,
    );
  });

  it("does not fire a completion event when the job finishes within the foreground wait", async () => {
    const events: unknown[] = [];
    const id = createImagegenJob("mind-fast", "any:model", "p", "f", {
      generate: async () => Buffer.from("png"),
      deliver: async (mind, event) => {
        events.push({ mind, event });
        return { delivered: true };
      },
    });
    const job = await waitForImagegenJob("mind-fast", id, 1000);
    assert.equal(job?.status, "done");
    // Let any (erroneous) async notification flush.
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(events.length, 0, "a foregrounded job must not also send a completion event");
  });

  it("fires a single completion event when the job outlives the foreground wait", async () => {
    const bodies: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const id = createImagegenJob("mind-slow", "any:model", "p", "f", {
      generate: async () => {
        await gate;
        return Buffer.from("png");
      },
      deliver: async (_mind, event) => {
        bodies.push(event.body);
        return { delivered: true };
      },
    });

    // Foreground poll times out with the job still running → it drops to background.
    const timedOut = await waitForImagegenJob("mind-slow", id, 10);
    assert.equal(timedOut?.status, "running");
    assert.equal(bodies.length, 0, "no event before completion");

    // Let generation finish; the backgrounded job should now notify exactly once.
    release();
    const done = await waitForImagegenJob("mind-slow", id, 2000);
    assert.equal(done?.status, "done");
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(bodies.length, 1, "exactly one completion event when backgrounded");
    assert.match(bodies[0], /image ready/);
  });

  it("rejects a traversing filename without writing outside home/images", async () => {
    const id = createImagegenJob("mind-escape", "any:model", "p", "../../../etc/pwned", {
      generate: async () => Buffer.from("png"),
    });
    const job = await waitForImagegenJob("mind-escape", id, 1000);
    assert.equal(job?.status, "error");
    if (job?.status === "error") assert.match(job.error, /Invalid image filename/);
  });

  it("notifies the mind when a backgrounded job fails", async () => {
    const bodies: string[] = [];
    let release!: (err: Error) => void;
    const gate = new Promise<Buffer>((_resolve, reject) => {
      release = reject;
    });
    const id = createImagegenJob("mind-bgfail", "any:model", "p", "f", {
      generate: () => gate,
      deliver: async (_mind, event) => {
        bodies.push(event.body);
        return { delivered: true };
      },
    });

    // Foreground times out → the mind is told it's still generating (notifyOnDone).
    const timedOut = await waitForImagegenJob("mind-bgfail", id, 10);
    assert.equal(timedOut?.status, "running");

    // The background generation then fails — the mind must be told, not left waiting.
    release(new Error("provider exploded"));
    const done = await waitForImagegenJob("mind-bgfail", id, 2000);
    assert.equal(done?.status, "error");
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(bodies.length, 1, "a backgrounded failure must send exactly one event");
    assert.match(bodies[0], /image generation failed/);
  });
});

describe("imagegen xai provider", () => {
  const realFetch = globalThis.fetch;
  const PNG_B64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

  afterEach(() => {
    globalThis.fetch = realFetch;
    const config = readGlobalConfig();
    delete config.imagegen;
    delete config.ai;
    writeGlobalConfig(config);
    delete process.env.XAI_API_KEY;
  });

  function okImage(): Response {
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: [{ b64_json: PNG_B64 }] }),
    } as Response;
  }
  function forbidden(): Response {
    return { ok: false, status: 403, text: async () => "forbidden" } as Response;
  }

  it("registers into pi-ai's OAuth registry", async () => {
    registerXaiOAuthProvider();
    const { getOAuthProvider } = await import("@earendil-works/pi-ai/oauth");
    const p = getOAuthProvider("xai");
    assert.ok(p, "xai OAuth provider registered");
    assert.equal(p.id, "xai");
    assert.equal(p.usesCallbackServer, false);
    assert.equal(p.getApiKey({ access: "tok", refresh: "r", expires: 0 }), "tok");
  });

  it("validateXaiUrl accepts auth.x.ai over https and rejects anything else", () => {
    assert.equal(
      validateXaiUrl("https://auth.x.ai/oauth2/token"),
      "https://auth.x.ai/oauth2/token",
    );
    assert.throws(() => validateXaiUrl("https://evil.example/oauth2/token"), /non-xAI/);
    assert.throws(() => validateXaiUrl("http://auth.x.ai/oauth2/token"), /non-xAI/);
  });

  it("refreshToken keeps the old refresh token when xAI omits a new one", async () => {
    globalThis.fetch = (async () =>
      // Rotation response omits refresh_token — must fall back to the existing one.
      new Response(JSON.stringify({ access_token: "new-access", expires_in: 3600 }), {
        status: 200,
      })) as typeof fetch;
    const next = await xaiOAuthProvider.refreshToken({
      access: "old-access",
      refresh: "keep-me",
      expires: 0,
    });
    assert.equal(next.access, "new-access");
    assert.equal(next.refresh, "keep-me", "a missing refresh_token must not blank the grant");
  });

  it("refreshToken throws when the token response lacks an access_token", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ expires_in: 3600 }), { status: 200 })) as typeof fetch;
    await assert.rejects(
      xaiOAuthProvider.refreshToken({ access: "a", refresh: "r", expires: 0 }),
      /access_token|token/i,
    );
  });

  it("generates from a b64_json response", async () => {
    let seenAuth: string | undefined;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      seenAuth = new Headers(init.headers).get("authorization") ?? undefined;
      return okImage();
    }) as typeof fetch;
    const buf = await xaiGenerate("grok-imagine-image", "a fox", {
      kind: "api_key",
      token: "xai-key",
    });
    assert.deepEqual(buf, Buffer.from(PNG_B64, "base64"));
    assert.equal(seenAuth, "Bearer xai-key");
  });

  it("retries an OAuth 403 with the configured API key (payment-method swap)", async () => {
    process.env.XAI_API_KEY = "fallback-key";
    const tokens: string[] = [];
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      const auth = new Headers(init.headers).get("authorization") ?? "";
      tokens.push(auth);
      return auth === "Bearer fallback-key" ? okImage() : forbidden();
    }) as typeof fetch;

    const buf = await xaiGenerate("grok-imagine-image", "a fox", {
      kind: "oauth",
      token: "oauth-token",
    });
    assert.deepEqual(buf, Buffer.from(PNG_B64, "base64"));
    assert.deepEqual(
      tokens,
      ["Bearer oauth-token", "Bearer fallback-key"],
      "oauth first, then key",
    );
  });

  it("throws XaiNotEntitledError on OAuth 403 with no API key fallback", async () => {
    globalThis.fetch = (async () => forbidden()) as typeof fetch;
    await assert.rejects(
      xaiGenerate("grok-imagine-image", "x", { kind: "oauth", token: "oauth-token" }),
      (err: Error) => err instanceof XaiNotEntitledError,
    );
  });

  it("does not retry a 403 on an API-key credential (genuine auth failure)", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return forbidden();
    }) as typeof fetch;
    await assert.rejects(
      xaiGenerate("grok-imagine-image", "x", { kind: "api_key", token: "bad-key" }),
      /403/,
    );
    assert.equal(calls, 1, "no retry for an api_key 403");
  });

  it("xaiApiKeyFallback prefers imagegen config, then ai config, then env", () => {
    process.env.XAI_API_KEY = "env-key";
    assert.equal(xaiApiKeyFallback(), "env-key");
    const config = readGlobalConfig();
    config.ai = { providers: { xai: { apiKey: "ai-key" } } };
    writeGlobalConfig(config);
    assert.equal(xaiApiKeyFallback(), "ai-key");
    saveProviderConfig("xai", "imagegen-key");
    assert.equal(xaiApiKeyFallback(), "imagegen-key");
  });
});

describe("imagegen entitlement", () => {
  const realFetch = globalThis.fetch;
  const PNG_B64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const CODEX_SENTINEL = "Tool choice 'image_generation' not found in 'tools' parameter.";

  afterEach(() => {
    globalThis.fetch = realFetch;
    const config = readGlobalConfig();
    delete config.imagegen;
    delete config.ai;
    writeGlobalConfig(config);
    delete process.env.XAI_API_KEY;
  });

  function configureCodexOAuth() {
    const config = readGlobalConfig();
    config.ai = {
      providers: {
        "openai-codex": { oauth: { access: "codex-tok", refresh: "r", expires: 4102444800000 } },
      },
    };
    writeGlobalConfig(config);
  }

  it("hard-fails with an actionable message and caches not_entitled (codex)", async () => {
    configureCodexOAuth();
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ detail: CODEX_SENTINEL }), { status: 400 })) as typeof fetch;

    await assert.rejects(
      generateImage("openai-codex:gpt-image-2", "a cat"),
      /ChatGPT plan doesn't include/,
    );
    const ent = getEntitlement("openai-codex");
    assert.equal(ent?.state, "not_entitled");
    assert.ok(ent?.checkedAt);
  });

  it("caches entitled after a successful generation (codex)", async () => {
    configureCodexOAuth();
    globalThis.fetch = (async () => {
      const sse =
        "event: response.image_generation_call.partial_image\n" +
        `data: {"type":"response.image_generation_call.partial_image","partial_image_b64":"${PNG_B64}"}\n\n` +
        'data: {"type":"response.completed","response":{"output":[]}}\n\n';
      const bytes = new TextEncoder().encode(sse);
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const buf = await generateImage("openai-codex:gpt-image-2", "a cat");
    assert.deepEqual(buf, Buffer.from(PNG_B64, "base64"));
    assert.equal(getEntitlement("openai-codex")?.state, "entitled");
  });

  it("hard-fails and caches not_entitled when xAI OAuth 403s with no key fallback", async () => {
    const config = readGlobalConfig();
    config.ai = {
      providers: { xai: { oauth: { access: "x-tok", refresh: "r", expires: 4102444800000 } } },
    };
    writeGlobalConfig(config);
    globalThis.fetch = (async () => new Response("forbidden", { status: 403 })) as typeof fetch;

    await assert.rejects(
      generateImage("xai:grok-imagine-image", "a fox"),
      /plan tier isn't allowlisted/,
    );
    assert.equal(getEntitlement("xai")?.state, "not_entitled");
  });

  it("probeEntitlement(xai) records entitled on success and not_entitled on OAuth 403", async () => {
    // OAuth credential, no XAI_API_KEY fallback — a 403 is the tier-gating case.
    const config = readGlobalConfig();
    config.ai = {
      providers: { xai: { oauth: { access: "x-tok", refresh: "r", expires: 4102444800000 } } },
    };
    writeGlobalConfig(config);

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: [{ b64_json: PNG_B64 }] }), {
        status: 200,
      })) as typeof fetch;
    const ok = await probeEntitlement("xai");
    assert.equal(ok.state, "entitled");

    globalThis.fetch = (async () => new Response("forbidden", { status: 403 })) as typeof fetch;
    const bad = await probeEntitlement("xai");
    assert.equal(bad.state, "not_entitled");
    assert.match(bad.reason ?? "", /allowlisted/);
  });
});

describe("imagegen transient OAuth failure", () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
    const config = readGlobalConfig();
    delete config.imagegen;
    delete config.ai;
    writeGlobalConfig(config);
  });

  function configureCodexOAuth() {
    const config = readGlobalConfig();
    config.ai = {
      providers: { "openai-codex": { oauth: { access: "expired", refresh: "r", expires: 0 } } },
    };
    writeGlobalConfig(config);
  }

  it("generateImage surfaces a transient-auth message, not 'not configured'", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("token endpoint unreachable");
    }) as typeof fetch;
    configureCodexOAuth();
    await assert.rejects(generateImage("openai-codex:gpt-image-2", "a cat"), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /temporarily unavailable/i);
      assert.doesNotMatch(err.message, /not configured/i);
      return true;
    });
  });

  it("generateImage still says 'not configured' when the provider genuinely has no credentials", async () => {
    // No ai/imagegen config — codex is truly unconfigured (unchanged behavior).
    await assert.rejects(
      generateImage("openai-codex:gpt-image-2", "a cat"),
      /No openai-codex credentials configured/,
    );
  });

  it("searchModels skips a transiently-failing provider instead of failing the whole search", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("everything unreachable");
    }) as typeof fetch;
    configureCodexOAuth(); // codex OAuth refresh will throw (transient)
    saveProviderConfig("openrouter", "or-key"); // a second, key-configured provider

    // codex resolveCredential throws OAuthRefreshError → the loop must skip it;
    // openrouter's search runs (its fetch throws → per-search .catch → []).
    // The whole search resolves rather than rejecting with the codex error.
    const results = await searchModels();
    assert.deepEqual(results, []);
  });
});

describe("imagegen skill daemon error reporting", () => {
  const realFetch = globalThis.fetch;
  const savedEnv = {
    port: process.env.VOLUTE_DAEMON_PORT,
    token: process.env.VOLUTE_MIND_TOKEN,
    mind: process.env.VOLUTE_MIND,
  };

  function setDaemonEnv(present: boolean) {
    if (present) {
      process.env.VOLUTE_DAEMON_PORT = "1618";
      process.env.VOLUTE_MIND_TOKEN = "mind-token";
      process.env.VOLUTE_MIND = "test-mind";
    } else {
      delete process.env.VOLUTE_DAEMON_PORT;
      delete process.env.VOLUTE_MIND_TOKEN;
      delete process.env.VOLUTE_MIND;
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
    if (savedEnv.mind !== undefined) process.env.VOLUTE_MIND = savedEnv.mind;
    else delete process.env.VOLUTE_MIND;
  });

  describe("startImagegenJob", () => {
    it("reports no-env when daemon env vars are unset", async () => {
      setDaemonEnv(false);
      const res = await startImagegenJob("replicate:owner/model", "prompt", "file");
      assert.deepEqual(res, { ok: false, reason: "no-env" });
    });

    it("reports unreachable when the connection fails", async () => {
      setDaemonEnv(true);
      mockFetch(() => {
        throw new TypeError("fetch failed");
      });
      const res = await startImagegenJob("replicate:owner/model", "prompt", "file");
      assert.equal(res.ok === false && res.reason, "unreachable");
    });

    it("reports auth failure on 401", async () => {
      setDaemonEnv(true);
      mockFetch(() => jsonResponse(401, { error: "invalid token" }));
      const res = await startImagegenJob("replicate:owner/model", "prompt", "file");
      assert.equal(res.ok === false && res.reason, "auth");
      assert.equal(res.ok === false && res.reason === "auth" && res.status, 401);
    });

    it("reports auth failure on 403", async () => {
      setDaemonEnv(true);
      mockFetch(() => jsonResponse(403, { error: "forbidden" }));
      const res = await startImagegenJob("replicate:owner/model", "prompt", "file");
      assert.equal(res.ok === false && res.reason, "auth");
    });

    it("reports fallback on 404 (older daemon without the job route)", async () => {
      setDaemonEnv(true);
      mockFetch(() => jsonResponse(404, { error: "not found" }));
      const res = await startImagegenJob("replicate:owner/model", "prompt", "file");
      assert.deepEqual(res, { ok: false, reason: "fallback" });
    });

    it("reports fallback when imagegen is genuinely not configured", async () => {
      setDaemonEnv(true);
      mockFetch(() => jsonResponse(400, { error: "imagegen not configured" }));
      const res = await startImagegenJob("replicate:owner/model", "prompt", "file");
      assert.deepEqual(res, { ok: false, reason: "fallback" });
    });

    it("throws on an unexpected daemon error", async () => {
      setDaemonEnv(true);
      mockFetch(() => jsonResponse(500, { error: "boom" }));
      await assert.rejects(startImagegenJob("replicate:owner/model", "prompt", "file"), /boom/);
    });

    it("surfaces a transient-auth error instead of silently falling back", async () => {
      // A provider whose OAuth is temporarily failing must NOT be treated as
      // "not configured" (which would swap to a direct replicate fallback and
      // tell the mind to reconfigure a correctly-configured provider).
      setDaemonEnv(true);
      const transient =
        "openai-codex authentication is temporarily unavailable (OAuth token refresh failed).";
      mockFetch(() => jsonResponse(500, { error: transient }));
      await assert.rejects(
        startImagegenJob("openai-codex:gpt-image-2", "prompt", "file"),
        /temporarily unavailable/,
      );
    });

    it("returns the job id on success (202)", async () => {
      setDaemonEnv(true);
      mockFetch(() => jsonResponse(202, { jobId: "job-abc" }));
      const res = await startImagegenJob("replicate:owner/model", "prompt", "file");
      assert.deepEqual(res, { ok: true, value: "job-abc" });
    });
  });

  describe("pollImagegenJob", () => {
    it("reports no-env when daemon env vars are unset", async () => {
      setDaemonEnv(false);
      const res = await pollImagegenJob("job-1", 0);
      assert.deepEqual(res, { ok: false, reason: "no-env" });
    });

    it("reports fallback on 404 (unknown/lost job)", async () => {
      setDaemonEnv(true);
      mockFetch(() => jsonResponse(404, { error: "Job not found" }));
      const res = await pollImagegenJob("job-1", 0);
      assert.deepEqual(res, { ok: false, reason: "fallback" });
    });

    it("returns the job view on success", async () => {
      setDaemonEnv(true);
      mockFetch(() => jsonResponse(200, { status: "done", path: "/home/images/x.png" }));
      const res = await pollImagegenJob("job-1", 30);
      assert.equal(res.ok, true);
      assert.deepEqual(res.ok && res.value, { status: "done", path: "/home/images/x.png" });
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
