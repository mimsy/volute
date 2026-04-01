import { zValidator } from "@hono/zod-validator";
import type { OAuthAuthInfo, OAuthCredentials, OAuthPrompt } from "@mariozechner/pi-ai";
import { getProviders } from "@mariozechner/pi-ai";
import { getOAuthProvider, getOAuthProviders } from "@mariozechner/pi-ai/oauth";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import {
  getAiConfig,
  getAvailableModels,
  getConfiguredProviders,
  getEnabledModels,
  getUtilityModel,
  removeAiConfig,
  removeProviderConfig,
  resolveApiKey,
  saveProviderConfig,
  setEnabledModels,
  setUtilityModel,
} from "../../lib/ai-service.js";
import { readGlobalConfig, writeGlobalConfig } from "../../lib/config/setup.js";
import {
  deleteSystemsConfig,
  readSystemsConfig,
  writeSystemsConfig,
} from "../../lib/config/systems-config.js";
import { getMindManager } from "../../lib/daemon/mind-manager.js";
import { findMind } from "../../lib/mind/registry.js";
import {
  generateImage,
  getDefaultModel as getImagegenDefaultModel,
  getEnabledModels as getImagegenModels,
  getConfiguredProviders as getImagegenProviders,
  removeProviderConfig as removeImagegenProvider,
  saveProviderConfig as saveImagegenProvider,
  searchModels,
  setDefaultModel as setImagegenDefaultModel,
  setEnabledModels as setImagegenModels,
} from "../../lib/services/imagegen.js";
import { logBuffer } from "../../lib/util/log-buffer.js";
import log from "../../lib/util/logger.js";
import { type AuthEnv, requireAdmin } from "../middleware/auth.js";

const DEFAULT_API_URL = "https://volute.systems";
const igLog = log.child("imagegen");

const app = new Hono<AuthEnv>()
  .post("/restart", requireAdmin, (c) => {
    // Exit with code 1 so systemd Restart=on-failure restarts the daemon
    setTimeout(() => process.exit(1), 200);
    return c.json({ ok: true });
  })
  .post("/stop", requireAdmin, (c) => {
    // Exit with code 0 so systemd does not restart
    setTimeout(() => process.exit(0), 200);
    return c.json({ ok: true });
  })
  .get("/logs", async (c) => {
    const user = c.get("user");
    if (user.role !== "admin") return c.json({ error: "Forbidden" }, 403);

    return streamSSE(c, async (stream) => {
      // Send existing entries
      for (const entry of logBuffer.getEntries()) {
        await stream.writeSSE({ data: JSON.stringify(entry) });
      }

      // Subscribe to new entries
      const unsubscribe = logBuffer.subscribe((entry) => {
        stream.writeSSE({ data: JSON.stringify(entry) }).catch(() => {});
      });

      // Keep alive until client disconnects
      await new Promise<void>((resolve) => {
        stream.onAbort(() => {
          unsubscribe();
          resolve();
        });
      });
    });
  })
  .get("/info", (c) => {
    const config = readSystemsConfig();
    const globalConfig = readGlobalConfig();
    return c.json({ system: config?.system ?? null, name: globalConfig.name ?? null });
  })
  .put("/info", requireAdmin, zValidator("json", z.object({ name: z.string() })), (c) => {
    const { name } = c.req.valid("json");
    const config = readGlobalConfig();
    config.name = name.trim() || undefined;
    writeGlobalConfig(config);
    return c.json({ name: config.name ?? null });
  })
  .post(
    "/register",
    requireAdmin,
    zValidator("json", z.object({ name: z.string().min(1) })),
    async (c) => {
      const existing = readSystemsConfig();
      if (existing) {
        return c.json({ error: `Already registered as "${existing.system}"` }, 400);
      }
      const { name } = c.req.valid("json");
      const config = readGlobalConfig();
      const apiUrl = process.env.VOLUTE_SYSTEMS_URL || DEFAULT_API_URL;
      let apiKey: string;
      let system: string;
      try {
        const res = await fetch(`${apiUrl}/api/register`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: name.trim(),
            displayName: config.name || undefined,
            description: config.description || undefined,
          }),
        });
        if (!res.ok) {
          const err = (await res.json().catch(() => ({ error: `HTTP ${res.status}` }))) as {
            error: string;
          };
          return c.json({ error: err.error }, 502);
        }
        ({ apiKey, system } = (await res.json()) as { apiKey: string; system: string });
      } catch (err) {
        return c.json({ error: `Connection failed: ${(err as Error).message}` }, 502);
      }
      try {
        writeSystemsConfig({ apiKey, system, apiUrl });
      } catch (err) {
        return c.json(
          {
            error: `Registered as "${system}" but failed to save config: ${(err as Error).message}`,
          },
          500,
        );
      }
      return c.json({ system });
    },
  )
  .post(
    "/login",
    requireAdmin,
    zValidator("json", z.object({ key: z.string().min(1) })),
    async (c) => {
      const existing = readSystemsConfig();
      if (existing) {
        return c.json({ error: `Already logged in as "${existing.system}"` }, 400);
      }
      const { key } = c.req.valid("json");
      const apiUrl = process.env.VOLUTE_SYSTEMS_URL || DEFAULT_API_URL;
      let system: string;
      try {
        const res = await fetch(`${apiUrl}/api/whoami`, {
          headers: { Authorization: `Bearer ${key.trim()}` },
        });
        if (!res.ok) {
          const err = (await res.json().catch(() => ({ error: `HTTP ${res.status}` }))) as {
            error: string;
          };
          return c.json({ error: err.error }, 502);
        }
        ({ system } = (await res.json()) as { system: string });
      } catch (err) {
        return c.json({ error: `Connection failed: ${(err as Error).message}` }, 502);
      }
      try {
        writeSystemsConfig({ apiKey: key.trim(), system, apiUrl });
      } catch (err) {
        return c.json(
          {
            error: `Logged in as "${system}" but failed to save config: ${(err as Error).message}`,
          },
          500,
        );
      }
      return c.json({ system });
    },
  )
  .post("/logout", requireAdmin, (c) => {
    deleteSystemsConfig();
    return c.json({ ok: true });
  })
  // Proxy pages publish/status through daemon so CLI doesn't need direct file access
  .put("/pages/publish/:name", requireAdmin, async (c) => {
    const config = readSystemsConfig();
    if (!config) return c.json({ error: "Not connected to volute.systems" }, 400);
    const name = c.req.param("name");
    const body = await c.req.text();
    try {
      const res = await fetch(`${config.apiUrl}/api/pages/publish/${name}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
        },
        body,
      });
      const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      return c.json(data as Record<string, unknown>, res.status as ContentfulStatusCode);
    } catch (err) {
      return c.json({ error: `Connection failed: ${(err as Error).message}` }, 502);
    }
  })
  .get("/pages/status/:name", requireAdmin, async (c) => {
    const config = readSystemsConfig();
    if (!config) return c.json({ error: "Not connected to volute.systems" }, 400);
    const name = c.req.param("name");
    try {
      const res = await fetch(`${config.apiUrl}/api/pages/status/${name}`, {
        headers: { Authorization: `Bearer ${config.apiKey}` },
      });
      const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      return c.json(data as Record<string, unknown>, res.status as ContentfulStatusCode);
    } catch (err) {
      return c.json({ error: `Connection failed: ${(err as Error).message}` }, 502);
    }
  })
  // --- Imagegen service ---
  .get("/imagegen/providers", requireAdmin, (c) => {
    return c.json(getImagegenProviders());
  })
  .put(
    "/imagegen/providers/:id",
    requireAdmin,
    zValidator("json", z.object({ apiKey: z.string().min(1) })),
    (c) => {
      const id = c.req.param("id");
      const { apiKey } = c.req.valid("json");
      try {
        saveImagegenProvider(id, apiKey);
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : "Failed to save" }, 400);
      }
      return c.json({ ok: true });
    },
  )
  .delete("/imagegen/providers/:id", requireAdmin, (c) => {
    try {
      removeImagegenProvider(c.req.param("id"));
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Failed to remove" }, 400);
    }
    return c.json({ ok: true });
  })
  .get("/imagegen/models", requireAdmin, (c) => {
    const models = getImagegenModels();
    const defaultModel = getImagegenDefaultModel();
    return c.json({ models, defaultModel: defaultModel ?? null });
  })
  .put(
    "/imagegen/models",
    requireAdmin,
    zValidator(
      "json",
      z.object({ models: z.array(z.string()), defaultModel: z.string().nullable().optional() }),
    ),
    (c) => {
      const { models, defaultModel } = c.req.valid("json");
      setImagegenModels(models);
      if (defaultModel !== undefined) {
        setImagegenDefaultModel(defaultModel ?? undefined);
      }
      return c.json({ ok: true });
    },
  )
  .get("/imagegen/models/search", async (c) => {
    const q = c.req.query("q");
    const provider = c.req.query("provider");
    try {
      const results = await searchModels(q || undefined, provider || undefined);
      return c.json(results);
    } catch (err) {
      igLog.error("model search failed", log.errorData(err));
      return c.json({ error: err instanceof Error ? err.message : "Search failed" }, 500);
    }
  })
  .post(
    "/imagegen/generate",
    zValidator("json", z.object({ model: z.string().min(1), prompt: z.string().min(1) })),
    async (c) => {
      const { model, prompt } = c.req.valid("json");
      try {
        const buf = await generateImage(model, prompt);
        return new Response(new Uint8Array(buf), {
          headers: {
            "Content-Type": "image/png",
            "Content-Length": String(buf.length),
          },
        });
      } catch (err) {
        igLog.error("image generation failed", log.errorData(err));
        return c.json({ error: err instanceof Error ? err.message : "Generation failed" }, 500);
      }
    },
  )
  // --- AI Service config ---
  // Cached provider keys — refreshed by a daemon-level timer so individual mind
  // polls don't each trigger OAuth token refresh.
  .get("/ai/key/:provider", requireAdmin, async (c) => {
    const key = getCachedApiKey(c.req.param("provider"));
    if (!key) return c.json({ error: "No key available" }, 404);
    return c.json({ key });
  })
  .get("/ai/providers", requireAdmin, (c) => {
    const allProviders = getProviders();
    const oauthProviders = getOAuthProviders();
    const oauthMap = new Map(oauthProviders.map((p) => [p.id, p]));
    const ai = getAiConfig();

    const result = allProviders.map((id) => {
      const oauth = oauthMap.get(id);
      const providerConfig = ai?.providers[id];
      // Only show as configured if explicitly set up (not just env var)
      const configured = !!(providerConfig?.apiKey || providerConfig?.oauth);
      let authMethod: string | null = null;
      if (providerConfig?.oauth) authMethod = "oauth";
      else if (providerConfig?.apiKey) authMethod = "api_key";
      const health = authMethod === "oauth" ? oauthHealth.get(id) : undefined;
      return {
        id,
        oauth: !!oauth,
        oauthName: oauth?.name,
        usesCallbackServer: !!oauth?.usesCallbackServer,
        configured,
        authMethod,
        ...(health && { oauthHealthy: health.healthy, oauthError: health.error }),
      };
    });
    return c.json(result);
  })
  .get("/ai/models", requireAdmin, (c) => {
    const models = getAvailableModels();
    const enabled = new Set(getEnabledModels());
    return c.json(
      models.map((m) => ({
        id: m.id,
        name: m.name,
        provider: m.provider,
        contextWindow: m.contextWindow,
        maxTokens: m.maxTokens,
        enabled: enabled.has(m.id),
      })),
    );
  })
  .put(
    "/ai/models",
    requireAdmin,
    zValidator("json", z.object({ models: z.array(z.string()) })),
    (c) => {
      const { models } = c.req.valid("json");
      setEnabledModels(models);
      return c.json({ ok: true });
    },
  )
  .get("/ai/defaults", requireAdmin, (c) => {
    const config = readGlobalConfig();
    return c.json({
      spiritModel: config.spiritModel ?? null,
      utilityModel: getUtilityModel() ?? null,
    });
  })
  .put(
    "/ai/defaults",
    requireAdmin,
    zValidator(
      "json",
      z.object({
        spiritModel: z.string().nullable().optional(),
        utilityModel: z.string().nullable(),
      }),
    ),
    (c) => {
      const { spiritModel, utilityModel } = c.req.valid("json");
      const config = readGlobalConfig();
      if (spiritModel !== undefined) {
        config.spiritModel = spiritModel ?? undefined;
        writeGlobalConfig(config);
      }
      setUtilityModel(utilityModel ?? undefined);
      return c.json({ ok: true });
    },
  )
  .put(
    "/ai/providers/:id",
    requireAdmin,
    zValidator("json", z.object({ apiKey: z.string().min(1) })),
    (c) => {
      const id = c.req.param("id");
      const { apiKey } = c.req.valid("json");
      saveProviderConfig(id, { apiKey });
      return c.json({ ok: true });
    },
  )
  .delete("/ai/providers/:id", requireAdmin, (c) => {
    const id = c.req.param("id");
    removeProviderConfig(id);
    return c.json({ ok: true });
  })
  .delete("/ai", requireAdmin, (c) => {
    removeAiConfig();
    return c.json({ ok: true });
  })
  .post(
    "/ai/oauth/start",
    requireAdmin,
    zValidator("json", z.object({ provider: z.string().min(1) })),
    async (c) => {
      const { provider } = c.req.valid("json");
      const oauthProvider = getOAuthProvider(provider);
      if (!oauthProvider) {
        return c.json({ error: `OAuth not supported for provider: ${provider}` }, 400);
      }

      cleanupOAuthFlows();

      const flowId = crypto.randomUUID();
      const needsManualCode = !!oauthProvider.usesCallbackServer;
      const abortController = new AbortController();
      const flow: OAuthFlow = {
        status: "pending",
        needsManualCode,
        abortController,
        createdAt: Date.now(),
      };
      oauthFlows.set(flowId, flow);

      // For callback-based providers, onPrompt resolves with the code the user pastes.
      // We store a resolver so the POST /ai/oauth/code endpoint can fulfill it.
      const promptPromise = needsManualCode
        ? new Promise<string>((resolve) => {
            flow.resolveCode = resolve;
          })
        : undefined;

      oauthProvider
        .login({
          onAuth: (info: OAuthAuthInfo) => {
            const existing = oauthFlows.get(flowId);
            if (existing)
              Object.assign(existing, { url: info.url, instructions: info.instructions });
          },
          onPrompt: async (_prompt: OAuthPrompt) => {
            if (promptPromise) {
              const existing = oauthFlows.get(flowId);
              if (existing) existing.waitingForCode = true;
              return promptPromise;
            }
            return "";
          },
          onManualCodeInput: needsManualCode ? () => promptPromise! : undefined,
          signal: abortController.signal,
        })
        .then(async (credentials: OAuthCredentials) => {
          saveProviderConfig(provider, { oauth: credentials });
          const existing = oauthFlows.get(flowId);
          if (existing) existing.status = "complete";
          // Restart running minds that use this provider so they pick up new credentials
          await restartMindsForProvider(provider);
        })
        .catch((err: unknown) => {
          const existing = oauthFlows.get(flowId);
          if (existing) {
            existing.status = "error";
            existing.error = err instanceof Error ? err.message : String(err);
          }
        });

      // Wait briefly for onAuth to fire with URL
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const state = oauthFlows.get(flowId)!;
      return c.json({
        flowId,
        url: state.url,
        instructions: state.instructions,
        needsManualCode,
      });
    },
  )
  .post(
    "/ai/oauth/code/:flowId",
    requireAdmin,
    zValidator("json", z.object({ code: z.string().min(1) })),
    async (c) => {
      const flowId = c.req.param("flowId");
      const flow = oauthFlows.get(flowId);
      if (!flow) return c.json({ error: "Flow not found" }, 404);
      if (!flow.resolveCode) return c.json({ error: "Flow does not accept manual code" }, 400);
      const { code } = c.req.valid("json");
      const input = code.trim();

      // If the input looks like a localhost callback URL, forward it to pi-ai's
      // callback server running inside this process. This makes pi-ai use the
      // correct redirect_uri for the token exchange (the localhost one that
      // matched the authorization request), instead of the manual fallback URI.
      const localhostMatch = input.match(/^https?:\/\/localhost(:\d+)?(\/.*)/);
      if (localhostMatch) {
        const forwardUrl = `http://127.0.0.1${localhostMatch[1] ?? ""}${localhostMatch[2]}`;
        try {
          await fetch(forwardUrl);
        } catch {
          // Callback server may have already shut down — fall back to manual code
          flow.resolveCode(input);
        }
        return c.json({ ok: true });
      }

      flow.resolveCode(input);
      return c.json({ ok: true });
    },
  )
  .get("/ai/oauth/status/:flowId", requireAdmin, (c) => {
    const flowId = c.req.param("flowId");
    const flow = oauthFlows.get(flowId);
    if (!flow) return c.json({ error: "Flow not found" }, 404);
    const result: Record<string, unknown> = {
      status: flow.status,
      waitingForCode: flow.waitingForCode,
    };
    if (flow.url) result.url = flow.url;
    if (flow.instructions) result.instructions = flow.instructions;
    if (flow.error) result.error = flow.error;
    if (flow.status !== "pending") {
      // Delay deletion so retried polls still get the final status
      setTimeout(() => oauthFlows.delete(flowId), 30_000);
    }
    return c.json(result);
  })
  .get("/mind-defaults", requireAdmin, (c) => {
    const config = readGlobalConfig();
    return c.json(config.mindDefaults ?? {});
  })
  .put(
    "/mind-defaults",
    requireAdmin,
    zValidator(
      "json",
      z.object({
        cognition: z
          .object({
            model: z.string().optional(),
            thinkingLevel: z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]).optional(),
            maxThinkingTokens: z.number().nonnegative().optional(),
            tokenBudget: z.number().nonnegative().optional(),
            tokenBudgetPeriodMinutes: z.number().positive().optional(),
            compaction: z.object({ maxContextTokens: z.number().positive().optional() }).optional(),
          })
          .optional(),
        sleep: z
          .object({
            enabled: z.boolean().optional(),
            schedule: z.object({ sleep: z.string(), wake: z.string() }).optional(),
            wakeTriggers: z
              .object({
                mentions: z.boolean().optional(),
                dms: z.boolean().optional(),
                channels: z.array(z.string()).optional(),
                senders: z.array(z.string()).optional(),
              })
              .optional(),
          })
          .optional(),
        schedules: z
          .array(
            z.object({
              id: z.string().min(1),
              cron: z.string().optional(),
              message: z.string().optional(),
              script: z.string().optional(),
              session: z.string().optional(),
              enabled: z.boolean(),
              whileSleeping: z.enum(["skip", "queue", "trigger-wake"]).optional(),
            }),
          )
          .optional(),
      }),
    ),
    (c) => {
      const mindDefaults = c.req.valid("json");
      const config = readGlobalConfig();
      config.mindDefaults = mindDefaults;
      writeGlobalConfig(config);
      return c.json({ ok: true });
    },
  );

// In-memory OAuth flow tracking
type OAuthFlow = {
  status: "pending" | "complete" | "error";
  error?: string;
  url?: string;
  instructions?: string;
  needsManualCode?: boolean;
  waitingForCode?: boolean;
  resolveCode?: (code: string) => void;
  abortController?: AbortController;
  createdAt: number;
};
const oauthFlows = new Map<string, OAuthFlow>();

// Abort all pending flows and clear the map
function cleanupOAuthFlows() {
  for (const [id, flow] of oauthFlows) {
    if (flow.status === "pending") {
      flow.abortController?.abort();
    }
    oauthFlows.delete(id);
  }
}

// --- Restart minds after credential refresh ---
// Maps provider IDs to the template types that use them.
const PROVIDER_TEMPLATES: Record<string, (t: string | undefined) => boolean> = {
  anthropic: (t) => !t || t === "claude",
};

async function restartMindsForProvider(provider: string): Promise<void> {
  const matchTemplate = PROVIDER_TEMPLATES[provider];
  if (!matchTemplate) return; // unknown provider → no minds to restart

  const manager = getMindManager();
  const running = manager.getRunningMinds();
  for (const name of running) {
    try {
      const entry = await findMind(name);
      if (entry && matchTemplate(entry.template)) {
        slog.info(`restarting ${name} after ${provider} credential refresh`);
        await manager.restartMind(name);
      }
    } catch (err) {
      slog.warn(`failed to check mind ${name} for restart`, log.errorData(err));
    }
  }
}

// --- Cached API key resolution ---
// The daemon refreshes provider keys on a single timer so that N minds polling
// the /ai/key/:provider endpoint don't each trigger independent OAuth flows.
const apiKeyCache = new Map<string, { key: string; expiresAt: number }>();
const API_KEY_CACHE_TTL_MS = 4 * 60 * 1000; // 4 minutes
const REFRESH_CHECK_INTERVAL_MS = 60_000; // check every 60 seconds

function getCachedApiKey(provider: string): string | undefined {
  const cached = apiKeyCache.get(provider);
  if (cached && Date.now() < cached.expiresAt) return cached.key;
  return undefined;
}

let keyRefreshTimer: ReturnType<typeof setInterval> | null = null;

const slog = log.child("ai-keys");

// --- OAuth health tracking ---
const oauthHealth = new Map<string, { healthy: boolean; error?: string; since?: number }>();

/** Check whether an OAuth token needs refresh (expired or <15 min remaining). */
export function needsRefresh(oauth: OAuthCredentials): boolean {
  const expires = oauth.expires;
  if (!expires || Date.now() >= expires) return true;
  return expires - Date.now() < 15 * 60 * 1000;
}

export async function refreshApiKeyCache(): Promise<void> {
  const ai = getAiConfig();
  const providers = getConfiguredProviders();

  // Clean stale health entries for providers no longer configured
  for (const id of oauthHealth.keys()) {
    if (!providers.includes(id)) oauthHealth.delete(id);
  }

  for (const provider of providers) {
    const providerConfig = ai?.providers[provider];
    // Skip non-OAuth providers — API keys and env vars don't expire
    if (!providerConfig?.oauth) continue;

    if (!needsRefresh(providerConfig.oauth) && getCachedApiKey(provider)) {
      // Token not near expiry and cached — mark healthy if not already tracked
      if (!oauthHealth.has(provider)) oauthHealth.set(provider, { healthy: true });
      continue;
    }

    try {
      const key = await resolveApiKey(provider);
      if (key) {
        apiKeyCache.set(provider, { key, expiresAt: Date.now() + API_KEY_CACHE_TTL_MS });
        oauthHealth.set(provider, { healthy: true });
      } else {
        // resolveApiKey swallows OAuth errors and returns undefined — treat as unhealthy
        oauthHealth.set(provider, {
          healthy: false,
          error: "Failed to resolve credentials",
          since: oauthHealth.get(provider)?.since ?? Date.now(),
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      slog.warn(`API key refresh failed for ${provider}`, log.errorData(err));
      oauthHealth.set(provider, { healthy: false, error: message, since: Date.now() });
    }
  }
}

export function startApiKeyRefresh(): void {
  if (keyRefreshTimer) return;
  // Initial population
  refreshApiKeyCache().catch((err) => {
    slog.warn("initial API key cache refresh failed", log.errorData(err));
  });
  keyRefreshTimer = setInterval(() => {
    refreshApiKeyCache().catch((err) => {
      slog.warn("periodic API key cache refresh failed", log.errorData(err));
    });
  }, REFRESH_CHECK_INTERVAL_MS);
}

export function stopApiKeyRefresh(): void {
  if (keyRefreshTimer) {
    clearInterval(keyRefreshTimer);
    keyRefreshTimer = null;
  }
}

export default app;
