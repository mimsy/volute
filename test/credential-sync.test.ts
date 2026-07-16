import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { removeProviderConfig, saveProviderConfig } from "../packages/daemon/src/lib/ai-service.js";
import {
  injectPiProviderCredentials,
  syncProviderToMinds,
  writeClaudeCredentials,
  writePiProviderKey,
  writePiProviderOAuth,
} from "../packages/daemon/src/lib/daemon/credential-sync.js";

function tmpRoot(label: string): string {
  const dir = resolve(
    tmpdir(),
    `volute-credsync-${process.pid}-${label}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

const OAUTH = { access: "sk-ant-oat01-NEW", refresh: "sk-ant-ort01-NEW", expires: 1782152959152 };

describe("writeClaudeCredentials", () => {
  it("writes the claudeAiOauth credentials file and returns the config dir", async () => {
    const dir = tmpRoot("claude");
    const homeDir = resolve(dir, "home");
    mkdirSync(homeDir, { recursive: true });

    const claudeDir = await writeClaudeCredentials(homeDir, "mymind", OAUTH);

    assert.equal(claudeDir, resolve(homeDir, ".claude"));
    const creds = JSON.parse(readFileSync(resolve(claudeDir, ".credentials.json"), "utf-8"));
    assert.deepEqual(creds, {
      claudeAiOauth: {
        accessToken: OAUTH.access,
        refreshToken: OAUTH.refresh,
        expiresAt: new Date(OAUTH.expires).toISOString(),
        scopes: ["user:inference", "user:profile"],
      },
    });
  });
});

describe("writePiProviderKey", () => {
  it("sets the provider api_key entry while preserving other providers", async () => {
    const dir = tmpRoot("pi");
    const piAgentDir = resolve(dir, ".mind", "pi-agent");
    mkdirSync(piAgentDir, { recursive: true });
    writeFileSync(
      resolve(piAgentDir, "auth.json"),
      JSON.stringify({ openai: { type: "api_key", key: "openai-key" } }),
    );

    await writePiProviderKey(piAgentDir, "mymind", "anthropic", OAUTH.access);

    const auth = JSON.parse(readFileSync(resolve(piAgentDir, "auth.json"), "utf-8"));
    assert.deepEqual(auth, {
      openai: { type: "api_key", key: "openai-key" },
      anthropic: { type: "api_key", key: OAUTH.access },
    });
  });

  it("creates auth.json when none exists", async () => {
    const dir = tmpRoot("pi-fresh");
    const piAgentDir = resolve(dir, ".mind", "pi-agent");
    await writePiProviderKey(piAgentDir, "mymind", "anthropic", OAUTH.access);
    const auth = JSON.parse(readFileSync(resolve(piAgentDir, "auth.json"), "utf-8"));
    assert.deepEqual(auth, { anthropic: { type: "api_key", key: OAUTH.access } });
  });
});

describe("writePiProviderOAuth", () => {
  it("stores the full oauth credential, preserving other providers", async () => {
    const dir = tmpRoot("pi-oauth");
    const piAgentDir = resolve(dir, ".mind", "pi-agent");
    mkdirSync(piAgentDir, { recursive: true });
    writeFileSync(
      resolve(piAgentDir, "auth.json"),
      JSON.stringify({ openai: { type: "api_key", key: "openai-key" } }),
    );

    const copilotOauth = {
      ...OAUTH,
      availableModelIds: ["claude-sonnet-4.6"],
    };
    await writePiProviderOAuth(piAgentDir, "mymind", "github-copilot", copilotOauth);

    const auth = JSON.parse(readFileSync(resolve(piAgentDir, "auth.json"), "utf-8"));
    assert.deepEqual(auth, {
      openai: { type: "api_key", key: "openai-key" },
      "github-copilot": { type: "oauth", ...copilotOauth },
    });
  });

  it("creates auth.json when none exists", async () => {
    const dir = tmpRoot("pi-oauth-fresh");
    const piAgentDir = resolve(dir, ".mind", "pi-agent");
    await writePiProviderOAuth(piAgentDir, "mymind", "github-copilot", OAUTH);
    const auth = JSON.parse(readFileSync(resolve(piAgentDir, "auth.json"), "utf-8"));
    assert.deepEqual(auth, { "github-copilot": { type: "oauth", ...OAUTH } });
  });
});

describe("injectPiProviderCredentials", () => {
  it("degrades to the static api_key + env var (never re-refreshing) when OAuth is transiently failing", async () => {
    // anthropic is registered in pi-ai's OAuth registry, so the expired grant
    // actually attempts a refresh; the failing fetch makes it throw. The provider
    // ALSO has a static key configured — the fallback must land that key as an
    // api_key entry (not a flattened OAuth blob) and set the env-var fallback.
    const dir = tmpRoot("pi-inject-blip");
    const piAgentDir = resolve(dir, ".mind", "pi-agent");
    const realFetch = globalThis.fetch;
    const savedEnvKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    globalThis.fetch = (async () => {
      throw new TypeError("token endpoint unreachable");
    }) as typeof fetch;
    const env: Record<string, string | undefined> = {};
    try {
      saveProviderConfig("anthropic", {
        oauth: { access: "expired", refresh: "r", expires: 0 },
        apiKey: "static-anthropic-key",
      });
      await injectPiProviderCredentials({
        provider: "anthropic",
        piAgentDir,
        baseName: "mymind",
        mindName: "mymind",
        env,
      });

      const auth = JSON.parse(readFileSync(resolve(piAgentDir, "auth.json"), "utf-8"));
      assert.equal(
        auth.anthropic.type,
        "api_key",
        "must write an api_key entry, not an oauth blob",
      );
      assert.equal(auth.anthropic.key, "static-anthropic-key");
      assert.equal(env.PI_CODING_AGENT_DIR, piAgentDir);
      assert.equal(env.ANTHROPIC_API_KEY, "static-anthropic-key", "env-var fallback must be set");
    } finally {
      globalThis.fetch = realFetch;
      if (savedEnvKey !== undefined) process.env.ANTHROPIC_API_KEY = savedEnvKey;
      else delete process.env.ANTHROPIC_API_KEY;
      removeProviderConfig("anthropic");
    }
  });
});

describe("syncProviderToMinds", () => {
  it("updates claude creds + pi-with-anthropic auth, skips others", async () => {
    const root = tmpRoot("sync");

    // claude mind
    const claudeDir = resolve(root, "claudey");
    mkdirSync(resolve(claudeDir, "home"), { recursive: true });

    // pi mind that already uses anthropic
    const piDir = resolve(root, "piggy");
    const piAgent = resolve(piDir, ".mind", "pi-agent");
    mkdirSync(piAgent, { recursive: true });
    writeFileSync(
      resolve(piAgent, "auth.json"),
      JSON.stringify({ anthropic: { type: "api_key", key: "OLD" } }),
    );

    // pi mind that does NOT use anthropic
    const piOtherDir = resolve(root, "piother");
    const piOtherAgent = resolve(piOtherDir, ".mind", "pi-agent");
    mkdirSync(piOtherAgent, { recursive: true });
    writeFileSync(
      resolve(piOtherAgent, "auth.json"),
      JSON.stringify({ openai: { type: "api_key", key: "openai-key" } }),
    );

    // codex mind — should be untouched
    const codexDir = resolve(root, "codexy");
    mkdirSync(codexDir, { recursive: true });

    const entries: Record<string, { name: string; template?: string; dir: string }> = {
      claudey: { name: "claudey", template: "claude", dir: claudeDir },
      piggy: { name: "piggy", template: "pi", dir: piDir },
      piother: { name: "piother", template: "pi", dir: piOtherDir },
      codexy: { name: "codexy", template: "codex", dir: codexDir },
    };

    await syncProviderToMinds("anthropic", {
      getOauth: () => OAUTH,
      listRunning: () => Object.keys(entries),
      lookup: async (name) => entries[name],
    });

    // claude updated
    const claudeCreds = JSON.parse(
      readFileSync(resolve(claudeDir, "home", ".claude", ".credentials.json"), "utf-8"),
    );
    assert.equal(claudeCreds.claudeAiOauth.accessToken, OAUTH.access);

    // pi-with-anthropic updated
    const piAuth = JSON.parse(readFileSync(resolve(piAgent, "auth.json"), "utf-8"));
    assert.equal(piAuth.anthropic.key, OAUTH.access);

    // pi-without-anthropic untouched (no anthropic entry added)
    const piOtherAuth = JSON.parse(readFileSync(resolve(piOtherAgent, "auth.json"), "utf-8"));
    assert.equal(piOtherAuth.anthropic, undefined);
    assert.equal(piOtherAuth.openai.key, "openai-key");

    // codex untouched
    assert.equal(existsSync(resolve(codexDir, "home", ".claude", ".credentials.json")), false);
  });

  it("updates pi-with-xai auth as api_key, skips claude and pi-without-xai", async () => {
    const root = tmpRoot("sync-xai");
    const XAI_OAUTH = { access: "xai-oat-NEW", refresh: "xai-ort-NEW", expires: 1782152959152 };

    // pi mind that already uses xai
    const piDir = resolve(root, "grokky");
    const piAgent = resolve(piDir, ".mind", "pi-agent");
    mkdirSync(piAgent, { recursive: true });
    writeFileSync(
      resolve(piAgent, "auth.json"),
      JSON.stringify({ xai: { type: "api_key", key: "OLD" } }),
    );

    // pi mind that does NOT use xai
    const piOtherDir = resolve(root, "piother");
    const piOtherAgent = resolve(piOtherDir, ".mind", "pi-agent");
    mkdirSync(piOtherAgent, { recursive: true });
    writeFileSync(
      resolve(piOtherAgent, "auth.json"),
      JSON.stringify({ anthropic: { type: "api_key", key: "ant-key" } }),
    );

    // claude mind — xai has no claude support, must be untouched
    const claudeDir = resolve(root, "claudey");
    mkdirSync(resolve(claudeDir, "home"), { recursive: true });

    const entries: Record<string, { name: string; template?: string; dir: string }> = {
      grokky: { name: "grokky", template: "pi", dir: piDir },
      piother: { name: "piother", template: "pi", dir: piOtherDir },
      claudey: { name: "claudey", template: "claude", dir: claudeDir },
    };

    await syncProviderToMinds("xai", {
      getOauth: () => XAI_OAUTH,
      listRunning: () => Object.keys(entries),
      lookup: async (name) => entries[name],
    });

    // pi-with-xai updated to the new access token, still an api_key entry
    const piAuth = JSON.parse(readFileSync(resolve(piAgent, "auth.json"), "utf-8"));
    assert.equal(piAuth.xai.key, XAI_OAUTH.access);
    assert.equal(piAuth.xai.type, "api_key");

    // pi-without-xai untouched (no xai entry added)
    const piOtherAuth = JSON.parse(readFileSync(resolve(piOtherAgent, "auth.json"), "utf-8"));
    assert.equal(piOtherAuth.xai, undefined);
    assert.equal(piOtherAuth.anthropic.key, "ant-key");

    // claude untouched — xai never writes claude creds
    assert.equal(existsSync(resolve(claudeDir, "home", ".claude", ".credentials.json")), false);
  });

  it("no-ops for unsupported providers and when oauth is missing", async () => {
    await syncProviderToMinds("openai-codex", {
      getOauth: () => OAUTH,
      listRunning: () => {
        throw new Error("should not enumerate minds for unsupported provider");
      },
      lookup: async () => undefined,
    });
    await syncProviderToMinds("anthropic", {
      getOauth: () => undefined,
      listRunning: () => {
        throw new Error("should not enumerate minds when oauth missing");
      },
      lookup: async () => undefined,
    });
  });
});
