import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
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

    const claudeDir = await writeClaudeCredentials(dir, "mymind", OAUTH);

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

    await writePiProviderKey(dir, "mymind", "anthropic", OAUTH.access);

    const auth = JSON.parse(readFileSync(resolve(piAgentDir, "auth.json"), "utf-8"));
    assert.deepEqual(auth, {
      openai: { type: "api_key", key: "openai-key" },
      anthropic: { type: "api_key", key: OAUTH.access },
    });
  });

  it("creates auth.json when none exists", async () => {
    const dir = tmpRoot("pi-fresh");
    const piAgentDir = resolve(dir, ".mind", "pi-agent");
    await writePiProviderKey(dir, "mymind", "anthropic", OAUTH.access);
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
    await writePiProviderOAuth(dir, "mymind", "github-copilot", copilotOauth);

    const auth = JSON.parse(readFileSync(resolve(piAgentDir, "auth.json"), "utf-8"));
    assert.deepEqual(auth, {
      openai: { type: "api_key", key: "openai-key" },
      "github-copilot": { type: "oauth", ...copilotOauth },
    });
  });

  it("creates auth.json when none exists", async () => {
    const dir = tmpRoot("pi-oauth-fresh");
    const piAgentDir = resolve(dir, ".mind", "pi-agent");
    await writePiProviderOAuth(dir, "mymind", "github-copilot", OAUTH);
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
        dir,
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

// #1110: under user isolation the daemon is root, and every path below the mind
// dir is the mind's to rearrange. None of these may be written (or read) through.
describe("credential writes refuse links a mind planted", () => {
  function victimFile(content: string): string {
    const path = resolve(tmpRoot("victim"), "victim");
    writeFileSync(path, content);
    return path;
  }

  it("a symlink at home/.claude/.credentials.json", async () => {
    const dir = tmpRoot("claude-link-file");
    mkdirSync(resolve(dir, "home", ".claude"), { recursive: true });
    const victim = victimFile("untouched");
    symlinkSync(victim, resolve(dir, "home", ".claude", ".credentials.json"));
    await assert.rejects(writeClaudeCredentials(dir, "mymind", OAUTH), /ELOOP/);
    assert.equal(readFileSync(victim, "utf-8"), "untouched");
  });

  it("a symlinked home/.claude directory", async () => {
    const dir = tmpRoot("claude-link-dir");
    mkdirSync(resolve(dir, "home"), { recursive: true });
    const elsewhere = tmpRoot("claude-elsewhere");
    symlinkSync(elsewhere, resolve(dir, "home", ".claude"));
    await assert.rejects(writeClaudeCredentials(dir, "mymind", OAUTH), /escapes base directory/);
    assert.equal(existsSync(resolve(elsewhere, ".credentials.json")), false);
  });

  it("a home/ swapped for a link out of the mind dir", async () => {
    const dir = tmpRoot("claude-link-home");
    const elsewhere = tmpRoot("home-elsewhere");
    mkdirSync(resolve(elsewhere, ".claude"));
    symlinkSync(elsewhere, resolve(dir, "home"));
    await assert.rejects(writeClaudeCredentials(dir, "mymind", OAUTH), /escapes base directory/);
    assert.equal(existsSync(resolve(elsewhere, ".claude", ".credentials.json")), false);
  });

  it("a symlink at pi-agent/auth.json is neither read nor written", async () => {
    const dir = tmpRoot("pi-link");
    mkdirSync(resolve(dir, ".mind", "pi-agent"), { recursive: true });
    const victim = victimFile(JSON.stringify({ secret: "another principal's" }));
    symlinkSync(victim, resolve(dir, ".mind", "pi-agent", "auth.json"));
    await assert.rejects(writePiProviderKey(dir, "mymind", "anthropic", OAUTH.access), /ELOOP/);
    assert.equal(readFileSync(victim, "utf-8"), JSON.stringify({ secret: "another principal's" }));
  });

  it("a FIFO at pi-agent/auth.json doesn't hang the refresh fan-out", async () => {
    const dir = tmpRoot("pi-fifo");
    mkdirSync(resolve(dir, ".mind", "pi-agent"), { recursive: true });
    await promisify(execFile)("mkfifo", [resolve(dir, ".mind", "pi-agent", "auth.json")]);
    const sync = syncProviderToMinds("anthropic", {
      getOauth: () => OAUTH,
      listRunning: () => ["piffy"],
      lookup: async () => ({ name: "piffy", template: "pi", dir }),
    });
    const hung = new Promise((r) => setTimeout(() => r("hung"), 2000).unref());
    assert.equal(await Promise.race([sync.then(() => "done"), hung]), "done");
  });
});
