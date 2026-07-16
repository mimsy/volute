import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  getAiConfig,
  OAuthRefreshError,
  resolveApiKey,
  resolveOAuthCredentials,
  resolveProviderKey,
} from "../ai-service.js";
import { chownMindDir, isIsolationEnabled } from "../mind/isolation.js";
import { findMind, mindDir } from "../mind/registry.js";
import log from "../util/logger.js";

const slog = log.child("cred-sync");

/**
 * Providers whose OAuth provider is registered only in the daemon's pi-ai, not
 * the mind's — so the mind can't resolve their OAuth blob and must consume the
 * already-derived access token as a flat api_key (the daemon stays the refresh
 * authority).
 */
const DAEMON_ONLY_OAUTH = new Set(["xai"]);

/**
 * Provider → env var pi-ai reads as an api-key fallback. Set alongside the
 * auth.json entry because the sandbox may block proper-lockfile from reading
 * auth.json, so the env var keeps getEnvApiKey() in pi-ai working.
 */
const PI_PROVIDER_ENV_VAR: Record<string, string> = {
  openrouter: "OPENROUTER_API_KEY",
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GEMINI_API_KEY",
  groq: "GROQ_API_KEY",
  cerebras: "CEREBRAS_API_KEY",
  xai: "XAI_API_KEY",
  mistral: "MISTRAL_API_KEY",
  zai: "ZAI_API_KEY",
};

export type AnthropicOauth = {
  access: string;
  refresh: string;
  expires: number;
};

/**
 * Write the Claude Code OAuth credentials file for a mind so the Agent SDK
 * authenticates natively. The SDK reads CLAUDE_CONFIG_DIR/.credentials.json and
 * reloads it when the file's mtime changes, so rewriting this file pushes a
 * fresh token into a running mind without a restart. Returns the config dir.
 */
export async function writeClaudeCredentials(
  homeDir: string,
  baseName: string,
  oauth: AnthropicOauth,
): Promise<string> {
  const claudeDir = resolve(homeDir, ".claude");
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(
    resolve(claudeDir, ".credentials.json"),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: oauth.access,
        refreshToken: oauth.refresh,
        expiresAt: oauth.expires ? new Date(oauth.expires).toISOString() : null,
        scopes: ["user:inference", "user:profile"],
      },
    }),
    { mode: 0o600 },
  );
  if (isIsolationEnabled()) {
    await chownMindDir(claudeDir, baseName);
  }
  return claudeDir;
}

/**
 * Set a provider's api_key entry in a pi mind's auth.json, preserving any other
 * providers already present. Used both at mind startup and by the refresh
 * fan-out. The pi template watches this file and reloads on change.
 */
export async function writePiProviderKey(
  piAgentDir: string,
  baseName: string,
  provider: string,
  key: string,
): Promise<void> {
  mkdirSync(piAgentDir, { recursive: true });
  const authPath = resolve(piAgentDir, "auth.json");
  const authData: Record<string, unknown> = existsSync(authPath)
    ? JSON.parse(readFileSync(authPath, "utf-8"))
    : {};
  authData[provider] = { type: "api_key", key };
  writeFileSync(authPath, JSON.stringify(authData, null, 2), { mode: 0o600 });
  if (isIsolationEnabled()) {
    await chownMindDir(piAgentDir, baseName);
  }
}

/**
 * Set a provider's oauth entry in a pi mind's auth.json, preserving any other
 * providers already present. Unlike writePiProviderKey, this stores the full
 * credential (access/refresh/expires + provider-specific extras) so pi-ai's own
 * OAuth resolution runs inside the mind — some providers (GitHub Copilot) derive
 * a per-credential baseUrl from this shape that a flattened api_key loses,
 * causing requests to hit the wrong backend. It also lets the mind refresh its
 * own token from the stored refresh grant instead of relying solely on the
 * daemon's refresh fan-out.
 */
export async function writePiProviderOAuth(
  piAgentDir: string,
  baseName: string,
  provider: string,
  oauth: Record<string, unknown>,
): Promise<void> {
  mkdirSync(piAgentDir, { recursive: true });
  const authPath = resolve(piAgentDir, "auth.json");
  const authData: Record<string, unknown> = existsSync(authPath)
    ? JSON.parse(readFileSync(authPath, "utf-8"))
    : {};
  authData[provider] = { type: "oauth", ...oauth };
  writeFileSync(authPath, JSON.stringify(authData, null, 2), { mode: 0o600 });
  if (isIsolationEnabled()) {
    await chownMindDir(piAgentDir, baseName);
  }
}

/**
 * Resolve and write a pi mind's provider credential into its auth.json + spawn
 * env (mutated in place). Prefers the full OAuth blob so pi-ai's own resolution
 * runs inside the mind; {@link DAEMON_ONLY_OAUTH} providers and static-key
 * providers get a flat api_key plus the provider env-var fallback.
 *
 * A transient OAuth refresh failure ({@link OAuthRefreshError}) never crashes
 * spawn: it falls back to a STATIC key only. It deliberately does NOT retry via
 * resolveApiKey, which would re-attempt the refresh (a second network call +
 * error log) and — worse — let a blip-then-success on the retry flatten the
 * rotated OAuth blob into an api_key entry, losing the baseUrl-deriving shape
 * (the 421 Misdirected Request case). Sets env.PI_CODING_AGENT_DIR when a
 * credential is written.
 */
export async function injectPiProviderCredentials(opts: {
  provider: string;
  piAgentDir: string;
  baseName: string;
  mindName: string;
  env: Record<string, string | undefined>;
}): Promise<void> {
  const { provider, piAgentDir, baseName, mindName, env } = opts;

  let oauthCreds: Awaited<ReturnType<typeof resolveOAuthCredentials>>;
  let oauthError: OAuthRefreshError | undefined;
  try {
    oauthCreds = await resolveOAuthCredentials(provider);
  } catch (err) {
    if (!(err instanceof OAuthRefreshError)) throw err;
    slog.warn(
      `OAuth token refresh failing for provider "${provider}" (mind ${mindName}); ` +
        `falling back to a static key if available`,
      log.errorData(err),
    );
    oauthError = err;
  }

  if (oauthCreds && !DAEMON_ONLY_OAUTH.has(provider)) {
    await writePiProviderOAuth(piAgentDir, baseName, provider, oauthCreds);
    env.PI_CODING_AGENT_DIR = piAgentDir;
    return;
  }

  // DAEMON_ONLY_OAUTH providers (xai) hand the resolved access token to the mind
  // as an api_key; otherwise resolve a key (static/env), avoiding a refresh retry
  // when OAuth is transiently failing.
  let apiKey: string | undefined;
  if (oauthCreds) {
    apiKey = oauthCreds.access;
  } else if (oauthError) {
    apiKey = await resolveProviderKey(provider, getAiConfig()?.providers[provider]?.apiKey);
  } else {
    apiKey = await resolveApiKey(provider);
  }

  if (apiKey) {
    await writePiProviderKey(piAgentDir, baseName, provider, apiKey);
    env.PI_CODING_AGENT_DIR = piAgentDir;
    const providerEnv = PI_PROVIDER_ENV_VAR[provider];
    if (providerEnv) env[providerEnv] = apiKey;
  } else if (oauthError) {
    slog.warn(
      `OAuth token refresh is temporarily failing for provider "${provider}" and no static key ` +
        `is available — mind ${mindName} may start but stay silent until it recovers`,
    );
  } else {
    slog.warn(`no API key found for provider "${provider}" — mind ${mindName} may fail to start`);
  }
}

type MindLookup = {
  name: string;
  template?: string;
  dir?: string;
  parent?: string;
};

type SyncDeps = {
  /** Current OAuth credentials for the provider (defaults to global config). */
  getOauth?: () => AnthropicOauth | undefined;
  /** Names of currently-running minds (injected by the daemon to avoid a cycle). */
  listRunning?: () => string[];
  /** Resolve a mind name to its registry entry. */
  lookup?: (name: string) => Promise<MindLookup | undefined>;
};

/** True if a pi mind's auth.json already has an entry for the given provider. */
function piUsesProvider(piAgentDir: string, provider: string): boolean {
  try {
    const authPath = resolve(piAgentDir, "auth.json");
    if (!existsSync(authPath)) return false;
    const data = JSON.parse(readFileSync(authPath, "utf-8")) as Record<string, unknown>;
    return data[provider] != null;
  } catch {
    return false;
  }
}

/**
 * Push a freshly-rotated provider token into every running mind that uses it.
 * Only `anthropic` (OAuth, claude + pi minds) is handled today. This is the
 * fan-out that makes the daemon the single refresh authority: when the daemon
 * rotates the token, running minds adopt it via file reload rather than each
 * refreshing the rotating grant independently (which invalidated each other).
 */
export async function syncProviderToMinds(provider: string, deps: SyncDeps = {}): Promise<void> {
  // anthropic (claude + pi minds) and xai (pi minds only — its OAuth provider is
  // daemon-registered, so minds consume the rotated token as an api_key).
  if (provider !== "anthropic" && provider !== "xai") return;

  const getOauth = deps.getOauth ?? (() => getAiConfig()?.providers[provider]?.oauth);
  const oauth = getOauth();
  if (!oauth?.access) return;

  const listRunning = deps.listRunning ?? (() => []);
  const lookup = deps.lookup ?? findMind;

  for (const name of listRunning()) {
    try {
      const entry = await lookup(name);
      if (!entry) continue;
      const dir = entry.dir ?? mindDir(name);
      const baseName = entry.parent ?? name;
      const template = entry.template;

      if (template === "pi") {
        const piAgentDir = resolve(dir, ".mind", "pi-agent");
        if (piUsesProvider(piAgentDir, provider)) {
          await writePiProviderKey(piAgentDir, baseName, provider, oauth.access);
        }
      } else if (provider === "anthropic" && (template === "claude" || !template)) {
        await writeClaudeCredentials(resolve(dir, "home"), baseName, oauth);
      }
    } catch (err) {
      // A desync leaves this mind on a stale token → its next model call auth-fails
      // until the next successful sync. Log at error so it's not buried as noise.
      slog.error(`failed to sync ${provider} credentials to mind ${name}`, log.errorData(err));
    }
  }
}
