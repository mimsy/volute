import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { Hono } from "hono";
import { setCookie } from "hono/cookie";
import {
  type GlobalConfig,
  type IsolationMode,
  isSetupComplete,
  readGlobalConfig,
  type SetupConfig,
  type SetupType,
  writeGlobalConfig,
} from "../../lib/setup.js";
import { createSession, SESSION_MAX_AGE } from "../middleware/auth.js";

const setup = new Hono();

setup.get("/status", (c) => {
  const complete = isSetupComplete();
  if (!complete) {
    return c.json({ complete });
  }
  const config = readGlobalConfig();
  return c.json({
    complete,
    config: { name: config.name, setup: config.setup },
  });
});

// Legacy configure endpoint (kept for backwards compatibility with CLI setup)
setup.post("/configure", async (c) => {
  if (isSetupComplete()) {
    return c.json({ error: "Setup already complete" }, 400);
  }

  let body: { name: string; type?: SetupType; isolation?: IsolationMode };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON in request body" }, 400);
  }

  if (!body.name?.trim()) {
    return c.json({ error: "System name is required" }, 400);
  }

  const setupType: SetupType = body.type ?? "local";
  const isolation: IsolationMode = body.isolation ?? "sandbox";

  if (setupType !== "local") {
    return c.json({ error: "Web setup only supports local install type" }, 400);
  }

  const configHome = process.env.VOLUTE_HOME ?? resolve(homedir(), ".volute");
  const mindsDir = resolve(configHome, "minds");

  try {
    mkdirSync(configHome, { recursive: true });
    mkdirSync(mindsDir, { recursive: true });
  } catch (err) {
    return c.json({ error: `Failed to create directories: ${(err as Error).message}` }, 500);
  }

  const existingConfig = readGlobalConfig();
  const setupConfig: SetupConfig = {
    type: setupType,
    mindsDir,
    isolation,
    service: false,
  };

  const config: GlobalConfig = {
    ...existingConfig,
    name: body.name.trim(),
    setup: setupConfig,
  };

  try {
    writeGlobalConfig(config);
  } catch (err) {
    return c.json({ error: `Failed to write configuration: ${(err as Error).message}` }, 500);
  }

  return c.json({ ok: true, config: { name: config.name, setup: config.setup } });
});

// Step 1: Create account + system config
setup.post("/account", async (c) => {
  if (isSetupComplete()) {
    return c.json({ error: "Setup already complete" }, 400);
  }

  let body: {
    systemName: string;
    username: string;
    password: string;
    displayName?: string;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON in request body" }, 400);
  }

  if (!body.systemName?.trim()) {
    return c.json({ error: "System name is required" }, 400);
  }
  if (!body.username?.trim()) {
    return c.json({ error: "Username is required" }, 400);
  }
  if (!body.password || body.password.length < 1) {
    return c.json({ error: "Password is required" }, 400);
  }

  // Create directories and write config
  const configHome = process.env.VOLUTE_HOME ?? resolve(homedir(), ".volute");
  const mindsDir = resolve(configHome, "minds");

  try {
    mkdirSync(configHome, { recursive: true });
    mkdirSync(mindsDir, { recursive: true });
  } catch (err) {
    return c.json({ error: `Failed to create directories: ${(err as Error).message}` }, 500);
  }

  const existingConfig = readGlobalConfig();
  const setupConfig: SetupConfig = {
    type: "local",
    mindsDir,
    isolation: "sandbox",
    service: false,
  };

  const config: GlobalConfig = {
    ...existingConfig,
    name: body.systemName.trim(),
    setup: setupConfig,
  };

  try {
    writeGlobalConfig(config);
  } catch (err) {
    return c.json({ error: `Failed to write configuration: ${(err as Error).message}` }, 500);
  }

  // Create user (first user becomes admin)
  try {
    const { createUser, updateUserProfile } = await import("../../lib/auth.js");
    const user = await createUser(body.username.trim(), body.password);

    // Set display name if provided
    if (body.displayName?.trim()) {
      await updateUserProfile(user.id, { display_name: body.displayName.trim() });
    }

    // Auto-login: create session and set cookie
    const sessionId = await createSession(user.id);
    setCookie(c, "volute_session", sessionId, {
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
      maxAge: Math.floor(SESSION_MAX_AGE / 1000),
    });

    return c.json({
      ok: true,
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        display_name: body.displayName?.trim() ?? null,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("UNIQUE constraint")) {
      return c.json({ error: "Username already exists" }, 409);
    }
    return c.json({ error: `Failed to create user: ${msg}` }, 500);
  }
});

// Step 2: Configure AI provider
setup.post("/provider", async (c) => {
  let body: { providerId: string; apiKey: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON in request body" }, 400);
  }

  if (!body.providerId?.trim()) {
    return c.json({ error: "Provider ID is required" }, 400);
  }
  if (!body.apiKey?.trim()) {
    return c.json({ error: "API key is required" }, 400);
  }

  try {
    const { saveProviderConfig } = await import("../../lib/ai-service.js");
    saveProviderConfig(body.providerId.trim(), { apiKey: body.apiKey.trim() });
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: `Failed to save provider: ${(err as Error).message}` }, 500);
  }
});

// Step 3: Configure models
setup.post("/models", async (c) => {
  let body: { models: string[]; spiritModel: string; utilityModel?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON in request body" }, 400);
  }

  if (!Array.isArray(body.models) || body.models.length === 0) {
    return c.json({ error: "At least one model must be selected" }, 400);
  }
  if (!body.spiritModel?.trim()) {
    return c.json({ error: "Spirit model is required" }, 400);
  }

  try {
    const { setEnabledModels, setUtilityModel } = await import("../../lib/ai-service.js");

    setEnabledModels(body.models);

    // Save spirit model to global config
    const config = readGlobalConfig();
    config.spiritModel = body.spiritModel.trim();
    writeGlobalConfig(config);

    // Save utility model
    if (body.utilityModel?.trim()) {
      setUtilityModel(body.utilityModel.trim());
    }

    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: `Failed to save models: ${(err as Error).message}` }, 500);
  }
});

// Step 4: Complete setup — start spirit, create DM
setup.post("/complete", async (c) => {
  try {
    const { ensureSpiritProject, syncSpiritTemplate } = await import("../../lib/spirit.js");
    const { startSpiritFull } = await import("../../lib/daemon/mind-service.js");

    await ensureSpiritProject();
    await syncSpiritTemplate();

    // Start the spirit if the daemon is running
    try {
      await startSpiritFull("volute");
    } catch (err) {
      // Spirit start failure is non-fatal during setup
      console.warn("Spirit start failed (non-fatal):", err);
    }

    // Create DM between admin and spirit
    let spiritConversationId: string | undefined;
    try {
      const { getOrCreateMindUser, listUsersByType } = await import("../../lib/auth.js");
      const { createConversation, findDMConversation } = await import(
        "../../lib/events/conversations.js"
      );

      const spiritUser = await getOrCreateMindUser("volute");

      // Find the admin user (first brain user)
      const brains = await listUsersByType("brain");
      const admin = brains.find((u) => u.role === "admin");

      if (admin) {
        const existing = await findDMConversation("volute", [admin.id, spiritUser.id]);
        if (existing) {
          spiritConversationId = existing;
        } else {
          const conv = await createConversation("volute", "volute", {
            participantIds: [admin.id, spiritUser.id],
            title: "Volute",
          });
          spiritConversationId = conv.id;
        }
      }
    } catch (err) {
      console.warn("Failed to create spirit DM (non-fatal):", err);
    }

    return c.json({ ok: true, spiritConversationId });
  } catch (err) {
    return c.json({ error: `Setup completion failed: ${(err as Error).message}` }, 500);
  }
});

export default setup;
