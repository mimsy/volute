import type { AuthEvent, AuthPrompt } from "@earendil-works/pi-ai";
import { builtinProviders, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import {
  addCustomModel,
  buildCustomModel,
  getAiConfig,
  getAvailableModels,
  getConfiguredProviders,
  getCustomModels,
  getEnabledModels,
  getUtilityModel,
  isAiConfigured,
  needsRefresh,
  providerOAuth,
  removeAiConfig,
  removeCustomModel,
  removeProviderConfig,
  resolveApiKey,
  saveProviderConfig,
  setEnabledModels,
  setUtilityModel,
} from "../../lib/ai-service.js";
import { getSpiritName, readGlobalConfig, writeGlobalConfig } from "../../lib/config/setup.js";
import {
  deleteSystemsConfig,
  readSystemsConfig,
  writeSystemsConfig,
} from "../../lib/config/systems-config.js";
import { getMindManager } from "../../lib/daemon/mind-manager.js";
import { getSpendBudget } from "../../lib/daemon/spend-budget.js";
import { countCappedMinds, findMind } from "../../lib/mind/registry.js";
import {
  generateImage,
  getDefaultModel as getImagegenDefaultModel,
  getEnabledModels as getImagegenModels,
  getConfiguredProviders as getImagegenProviders,
  probeEntitlement as probeImagegenEntitlement,
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
    // The daemon host's timezone is the canonical timeline timezone: period
    // keys are computed in server-local time, so remote viewers anchor their
    // boundary math and labels to it rather than the browser's zone.
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? null;
    return c.json({
      system: config?.system ?? null,
      name: globalConfig.name ?? null,
      spiritName: getSpiritName(),
      timezone,
      // Whether any AI model is available for minds to think with. A providerless
      // system spawns every mind mute, so the dashboard surfaces a banner (#606).
      // Boolean only — no provider details or secrets are exposed here.
      aiConfigured: isAiConfigured(),
    });
  })
  .put("/info", requireAdmin, zValidator("json", z.object({ name: z.string() })), async (c) => {
    const { name } = c.req.valid("json");
    const config = readGlobalConfig();
    const previousName = config.name;
    config.name = name.trim() || undefined;
    writeGlobalConfig(config);
    if (config.name !== previousName) {
      const { notifySpiritSystemChange } = await import("../../lib/mind/spirit.js");
      await notifySpiritSystemChange();
    }
    return c.json({ name: config.name ?? null });
  })
  // Current cap on total minds and how many currently count toward it.
  .get("/max-minds", requireAdmin, async (c) => {
    return c.json({
      maxMinds: readGlobalConfig().maxMinds ?? null,
      count: await countCappedMinds(),
    });
  })
  // Set (positive integer) or clear (null) the cap. null = unlimited.
  .put(
    "/max-minds",
    requireAdmin,
    zValidator("json", z.object({ maxMinds: z.number().int().positive().nullable() })),
    async (c) => {
      const { maxMinds } = c.req.valid("json");
      const config = readGlobalConfig();
      config.maxMinds = maxMinds ?? undefined;
      writeGlobalConfig(config);
      return c.json({ maxMinds: maxMinds ?? null, count: await countCappedMinds() });
    },
  )
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
  // Probe whether a provider's plan is entitled to generate images, caching the
  // verdict so Settings can badge it before any mind tries. Admin-only (it can
  // spend a small amount against the account — e.g. one xAI image on success).
  .post("/imagegen/providers/:id/probe", requireAdmin, async (c) => {
    try {
      const entitlement = await probeImagegenEntitlement(c.req.param("id"));
      return c.json(entitlement);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Probe failed" }, 400);
    }
  })
  .get("/imagegen/models", requireAdmin, (c) => {
    const models = getImagegenModels();
    const defaultModel = getImagegenDefaultModel();
    return c.json({ models, defaultModel: defaultModel ?? null });
  })
  // Mind-callable: minds need the configured default model to generate. The
  // full /imagegen/models route is requireAdmin, so minds read the default
  // here (authMiddleware only) instead of silently falling back to a hardcode.
  .get("/imagegen/default-model", (c) => {
    return c.json({ defaultModel: getImagegenDefaultModel() ?? null });
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
    const allProviders = getBuiltinProviders();
    const oauthMap = new Map(
      builtinProviders()
        .filter((p) => p.auth?.oauth)
        .map((p) => [p.id, p.auth.oauth!] as const),
    );
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
        configured,
        authMethod,
        ...(health && { oauthHealthy: health.healthy, oauthError: health.error }),
      };
    });
    return c.json(result);
  })
  .get("/ai/models", requireAdmin, async (c) => {
    const models = await getAvailableModels();
    const enabled = new Set(getEnabledModels());
    const customIds = new Set(getCustomModels().map((m) => `${m.provider}:${m.id}`));
    return c.json(
      models.map((m) => {
        const qualifiedId = `${m.provider}:${m.id}`;
        return {
          id: m.id,
          qualifiedId,
          name: m.name,
          provider: m.provider,
          contextWindow: m.contextWindow,
          maxTokens: m.maxTokens,
          enabled: enabled.has(qualifiedId),
          custom: customIds.has(qualifiedId),
        };
      }),
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
  .post(
    "/ai/models/custom",
    requireAdmin,
    zValidator(
      "json",
      z.object({ provider: z.string().min(1), id: z.string().min(1), name: z.string().optional() }),
    ),
    (c) => {
      const { provider, id, name } = c.req.valid("json");
      // Must be a provider we can clone metadata from, or the model would be
      // stored but never resolve.
      if (!buildCustomModel(provider, id)) {
        return c.json(
          { error: `No built-in model for provider "${provider}" to clone metadata from` },
          400,
        );
      }
      addCustomModel(provider, id, name);
      // Enable it immediately as a provider-qualified id (dedupe against enabled).
      setEnabledModels([...new Set([...getEnabledModels(), `${provider}:${id}`])]);
      return c.json({ ok: true });
    },
  )
  .delete("/ai/models/custom", requireAdmin, (c) => {
    const provider = c.req.query("provider");
    const id = c.req.query("id");
    if (!provider || !id) return c.json({ error: "provider and id are required" }, 400);
    removeCustomModel(provider, id);
    return c.json({ ok: true });
  })
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
      const oauth = providerOAuth(provider);
      if (!oauth) {
        return c.json({ error: `OAuth not supported for provider: ${provider}` }, 400);
      }

      cleanupOAuthFlows();

      const flowId = crypto.randomUUID();
      const abortController = new AbortController();
      const flow: OAuthFlow = {
        status: "pending",
        abortController,
        createdAt: Date.now(),
      };
      oauthFlows.set(flowId, flow);

      // The code the admin pastes back. pi-ai no longer advertises up front whether a
      // flow will ask for one (`usesCallbackServer` is gone), so the resolver is always
      // armed and `needsManualCode`/`waitingForCode` are set when a prompt actually
      // arrives. The UI shows its paste box on either flag, so a flow that only asks
      // after our 2s window still gets one — a beat later, via the status poll.
      const codePromise = new Promise<string>((resolve) => {
        flow.resolveCode = resolve;
      });

      oauth
        .login({
          signal: abortController.signal,
          notify: (event: AuthEvent) => {
            const existing = oauthFlows.get(flowId);
            if (!existing) return;
            if (event.type === "auth_url") {
              Object.assign(existing, { url: event.url, instructions: event.instructions });
            } else if (event.type === "device_code") {
              Object.assign(existing, {
                url: event.verificationUri,
                instructions: `Enter code: ${event.userCode}`,
              });
            } else if (event.type === "info" || event.type === "progress") {
              existing.instructions = event.message;
            }
          },
          prompt: (prompt: AuthPrompt) =>
            answerAuthPrompt(prompt, () => {
              const existing = oauthFlows.get(flowId);
              if (existing) {
                existing.needsManualCode = true;
                existing.waitingForCode = true;
              }
              return codePromise;
            }),
        })
        .then(async (credential) => {
          // Volute's stored shape predates pi-ai's type tag; drop it on the way out
          // so secrets.json keeps the shape every other reader expects.
          const { type: _type, ...credentials } = credential;
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

      // Wait briefly for the flow to announce an auth URL or device code.
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const state = oauthFlows.get(flowId)!;
      return c.json({
        flowId,
        url: state.url,
        instructions: state.instructions,
        needsManualCode: !!state.needsManualCode,
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
      const localhostMatch = input.match(/^https?:\/\/(?:localhost|127\.0\.0\.1)(:\d+)?(\/.*)/);
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
            // positive, not nonnegative: a 0 here is copied into every new mind's
            // volute.json and reads as "no cap", so an admin who typed 0 meaning
            // "no spending" would get the opposite of what they asked for.
            spendCap: z.number().positive().optional(),
            spendCapPeriodMinutes: z.number().positive().optional(),
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
              messages: z.array(z.string().min(1)).optional(),
              script: z.string().optional(),
              thread: z.string().optional(),
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
  )
  .get("/limits", requireAdmin, (c) => {
    const config = readGlobalConfig();
    return c.json({ systemSpendCapPerDay: config.limits?.systemSpendCapPerDay ?? null });
  })
  .put(
    "/limits",
    requireAdmin,
    zValidator(
      "json",
      z.object({ systemSpendCapPerDay: z.number().positive().nullable().optional() }),
    ),
    (c) => {
      const body = c.req.valid("json");
      const config = readGlobalConfig();
      // Limits are operational state, not credentials — readGlobalConfig/writeGlobalConfig
      // keep them in the host-readable config.json rather than secrets.json.
      const limits = { ...config.limits };
      if (body.systemSpendCapPerDay !== undefined) {
        if (body.systemSpendCapPerDay === null) delete limits.systemSpendCapPerDay;
        else limits.systemSpendCapPerDay = body.systemSpendCapPerDay;
      }
      config.limits = limits;
      writeGlobalConfig(config);
      try {
        // Apply to the live bucket so the cap means something before the next restart.
        // The budget is initialized after the web server starts listening, so a request
        // that lands in that window still saves the config and takes effect at boot.
        getSpendBudget().setSystemCap(limits.systemSpendCapPerDay);
      } catch (err) {
        log.warn("system spend cap saved but not applied live", log.errorData(err));
      }
      return c.json({ ok: true, systemSpendCapPerDay: limits.systemSpendCapPerDay ?? null });
    },
  );

// Some providers (Codex) open their login with a method selector. The web UI has
// no picker for it, so take the first option — the browser/callback flow, whose
// manual-code paste path already covers remote daemons. pi-ai's `prompt()` must
// resolve with a string or reject, so an empty option list throws rather than
// resolving to "" and letting the provider fail somewhere less legible.
export async function selectLoginMethod(prompt: {
  options: readonly { id: string }[];
}): Promise<string> {
  const first = prompt.options[0]?.id;
  if (first === undefined) throw new Error("OAuth login offered no method to select");
  return first;
}

/**
 * How the web UI answers a provider's login prompt.
 *
 * pi-ai 0.84 collapsed the old five login callbacks into `prompt()` + `notify()` —
 * onAuth/onDeviceCode became notify events — so the discrimination that used to
 * live in the provider's shape now lives here:
 *
 * - `select` — no picker in the UI; take the first option (see selectLoginMethod).
 * - `text` — a setting with a default, not a code. GitHub Copilot opens its login
 *   by asking for an Enterprise domain, "blank for github.com", *before* it
 *   announces anything. Parking that on the paste box strands the login: the box
 *   only renders once a URL exists, and the answer we want is empty, which
 *   `POST /ai/oauth/code` rejects. Answering it empty is what the pre-0.84
 *   callback shape did, and it lets the flow reach its device code.
 * - `manual_code` — the admin pastes the value back. Verified across every catalog
 *   flow that issues one (anthropic, openai-codex, openrouter): each announces an
 *   auth URL via notify() first, so the UI always has something to render beside
 *   the box.
 * - `secret` — no catalog provider issues one today, so there is no ordering fact
 *   to rely on. Rejecting rather than parking is deliberate: an unannounced secret
 *   prompt would reproduce exactly the Copilot strand above (spinner, no box), and
 *   the paste box is a cleartext field labelled "paste the redirect URL" — the
 *   wrong affordance for a secret. A throw surfaces something an admin can read.
 */
export async function answerAuthPrompt(
  prompt: AuthPrompt,
  requestCode: () => Promise<string>,
): Promise<string> {
  if (prompt.type === "select") return selectLoginMethod(prompt);
  if (prompt.type === "text") return "";
  if (prompt.type === "secret") {
    throw new Error(
      "OAuth login asked for a secret, which this UI cannot collect safely. " +
        "Use the CLI for this provider, or file an issue so the flow can be supported.",
    );
  }
  return requestCode();
}

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

// Abort all pending flows and clear the map.
// Resolving the code promise unblocks pi-ai's login function so it reaches
// its finally{} block which closes the callback server (e.g. :1455).
function cleanupOAuthFlows() {
  for (const [id, flow] of oauthFlows) {
    if (flow.status === "pending") {
      flow.resolveCode?.("");
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

export async function refreshApiKeyCache(): Promise<void> {
  const ai = getAiConfig();
  const providers = await getConfiguredProviders();

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
