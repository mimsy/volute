import { zValidator } from "@hono/zod-validator";
import { getOAuthProvider, getOAuthProviders, getProviders } from "@mariozechner/pi-ai";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import { getAiConfig, removeAiConfig, saveAiConfig } from "../../lib/ai-service.js";
import { logBuffer } from "../../lib/log-buffer.js";
import {
  deleteSystemsConfig,
  readSystemsConfig,
  writeSystemsConfig,
} from "../../lib/systems-config.js";
import { type AuthEnv, requireAdmin } from "../middleware/auth.js";

const DEFAULT_API_URL = "https://volute.systems";

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
    return c.json({ system: config?.system ?? null });
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
      const apiUrl = process.env.VOLUTE_SYSTEMS_URL || DEFAULT_API_URL;
      let apiKey: string;
      let system: string;
      try {
        const res = await fetch(`${apiUrl}/api/register`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: name.trim() }),
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
  // --- AI Service config ---
  .get("/ai/providers", requireAdmin, (c) => {
    const allProviders = getProviders();
    const oauthProviders = getOAuthProviders();
    const oauthMap = new Map(oauthProviders.map((p) => [p.id, p]));
    const result = allProviders.map((id) => {
      const oauth = oauthMap.get(id);
      return {
        id,
        oauth: !!oauth,
        oauthName: oauth?.name,
        usesCallbackServer: !!oauth?.usesCallbackServer,
      };
    });
    return c.json(result);
  })
  .get("/ai", requireAdmin, (c) => {
    const config = getAiConfig();
    if (!config) return c.json({ configured: false });
    return c.json({
      configured: true,
      provider: config.provider,
      model: config.model,
      authMethod: config.oauth ? "oauth" : config.apiKey ? "api_key" : "env_var",
    });
  })
  .put(
    "/ai",
    requireAdmin,
    zValidator(
      "json",
      z.object({
        provider: z.string().min(1),
        model: z.string().min(1),
        apiKey: z.string().optional(),
      }),
    ),
    (c) => {
      const { provider, model, apiKey } = c.req.valid("json");
      saveAiConfig({ provider, model, ...(apiKey ? { apiKey } : {}) });
      return c.json({ ok: true });
    },
  )
  .delete("/ai", requireAdmin, (c) => {
    removeAiConfig();
    return c.json({ ok: true });
  })
  .post("/ai/oauth/start", requireAdmin, async (c) => {
    const body = (await c.req.json()) as { provider: string; model: string };
    const oauthProvider = getOAuthProvider(body.provider);
    if (!oauthProvider) {
      return c.json({ error: `OAuth not supported for provider: ${body.provider}` }, 400);
    }

    const flowId = crypto.randomUUID();
    const needsManualCode = !!oauthProvider.usesCallbackServer;
    const flow: OAuthFlow = {
      status: "pending",
      needsManualCode,
    };
    oauthFlows.set(flowId, flow);

    // For callback-based providers, onPrompt resolves with the code the user pastes.
    // We store a resolver so the POST /ai/oauth/code endpoint can fulfill it.
    let resolvePrompt: ((value: string) => void) | undefined;
    const promptPromise = needsManualCode
      ? new Promise<string>((resolve) => {
          resolvePrompt = resolve;
          flow.resolveCode = resolve;
        })
      : undefined;

    oauthProvider
      .login({
        onAuth: (info) => {
          const existing = oauthFlows.get(flowId);
          if (existing) Object.assign(existing, { url: info.url, instructions: info.instructions });
        },
        onPrompt: async (prompt) => {
          if (promptPromise) {
            // Wait for user to paste the code via the web UI
            const existing = oauthFlows.get(flowId);
            if (existing) existing.waitingForCode = true;
            return promptPromise;
          }
          return "";
        },
        onManualCodeInput: needsManualCode ? () => promptPromise! : undefined,
      })
      .then((credentials) => {
        saveAiConfig({ provider: body.provider, model: body.model, oauth: credentials });
        const existing = oauthFlows.get(flowId);
        if (existing) existing.status = "complete";
      })
      .catch((err) => {
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
      url: (state as any).url,
      instructions: (state as any).instructions,
      needsManualCode,
    });
  })
  .post("/ai/oauth/code/:flowId", requireAdmin, async (c) => {
    const flowId = c.req.param("flowId");
    const flow = oauthFlows.get(flowId);
    if (!flow) return c.json({ error: "Flow not found" }, 404);
    if (!flow.resolveCode) return c.json({ error: "Flow does not accept manual code" }, 400);
    const body = (await c.req.json()) as { code: string };
    if (!body.code?.trim()) return c.json({ error: "Code is required" }, 400);
    flow.resolveCode(body.code.trim());
    return c.json({ ok: true });
  })
  .get("/ai/oauth/status/:flowId", requireAdmin, (c) => {
    const flowId = c.req.param("flowId");
    const flow = oauthFlows.get(flowId);
    if (!flow) return c.json({ error: "Flow not found" }, 404);
    const result: Record<string, unknown> = {
      status: flow.status,
      waitingForCode: flow.waitingForCode,
    };
    if (flow.error) result.error = flow.error;
    if (flow.status !== "pending") {
      oauthFlows.delete(flowId); // Clean up
    }
    return c.json(result);
  });

// In-memory OAuth flow tracking
type OAuthFlow = {
  status: "pending" | "complete" | "error";
  error?: string;
  needsManualCode?: boolean;
  waitingForCode?: boolean;
  resolveCode?: (code: string) => void;
};
const oauthFlows = new Map<string, OAuthFlow>();

export default app;
