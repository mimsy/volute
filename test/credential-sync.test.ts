import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import {
  syncProviderToMinds,
  writeClaudeCredentials,
  writePiProviderKey,
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
  it("writes the claudeAiOauth credentials file and returns the config dir", () => {
    const dir = tmpRoot("claude");
    const homeDir = resolve(dir, "home");
    mkdirSync(homeDir, { recursive: true });

    const claudeDir = writeClaudeCredentials(homeDir, "mymind", OAUTH);

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
  it("sets the provider api_key entry while preserving other providers", () => {
    const dir = tmpRoot("pi");
    const piAgentDir = resolve(dir, ".mind", "pi-agent");
    mkdirSync(piAgentDir, { recursive: true });
    writeFileSync(
      resolve(piAgentDir, "auth.json"),
      JSON.stringify({ openai: { type: "api_key", key: "openai-key" } }),
    );

    writePiProviderKey(piAgentDir, "mymind", "anthropic", OAUTH.access);

    const auth = JSON.parse(readFileSync(resolve(piAgentDir, "auth.json"), "utf-8"));
    assert.deepEqual(auth, {
      openai: { type: "api_key", key: "openai-key" },
      anthropic: { type: "api_key", key: OAUTH.access },
    });
  });

  it("creates auth.json when none exists", () => {
    const dir = tmpRoot("pi-fresh");
    const piAgentDir = resolve(dir, ".mind", "pi-agent");
    writePiProviderKey(piAgentDir, "mymind", "anthropic", OAUTH.access);
    const auth = JSON.parse(readFileSync(resolve(piAgentDir, "auth.json"), "utf-8"));
    assert.deepEqual(auth, { anthropic: { type: "api_key", key: OAUTH.access } });
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

  it("no-ops for non-anthropic providers and when oauth is missing", async () => {
    await syncProviderToMinds("openai-codex", {
      getOauth: () => OAUTH,
      listRunning: () => {
        throw new Error("should not enumerate minds for non-anthropic provider");
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
