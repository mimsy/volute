import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { getAiConfig } from "../ai-service.js";
import { chownMindDir, isIsolationEnabled } from "../mind/isolation.js";
import { findMind, mindDir } from "../mind/registry.js";
import log from "../util/logger.js";

const slog = log.child("cred-sync");

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
  if (provider !== "anthropic") return;

  const getOauth = deps.getOauth ?? (() => getAiConfig()?.providers.anthropic?.oauth);
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

      if (template === "claude" || !template) {
        await writeClaudeCredentials(resolve(dir, "home"), baseName, oauth);
      } else if (template === "pi") {
        const piAgentDir = resolve(dir, ".mind", "pi-agent");
        if (piUsesProvider(piAgentDir, "anthropic")) {
          await writePiProviderKey(piAgentDir, baseName, "anthropic", oauth.access);
        }
      }
    } catch (err) {
      slog.warn(`failed to sync ${provider} credentials to mind ${name}`, log.errorData(err));
    }
  }
}
