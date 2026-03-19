import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { Hono } from "hono";
import { setCookie } from "hono/cookie";
import log from "../../lib/logger.js";
import {
  type GlobalConfig,
  isSetupComplete,
  readGlobalConfig,
  type SetupConfig,
  type SetupType,
  writeGlobalConfig,
} from "../../lib/setup.js";
import {
  deleteSystemsConfig,
  readSystemsConfig,
  writeSystemsConfig,
} from "../../lib/systems-config.js";
import { createSession, SESSION_MAX_AGE } from "../middleware/auth.js";

const DEFAULT_API_URL = "https://volute.systems";

const setup = new Hono();

/** Create directories and write the initial setup config for a local install. */
function writeSetupConfig(systemName: string, description?: string): GlobalConfig {
  const configHome = process.env.VOLUTE_HOME ?? resolve(homedir(), ".volute");
  const mindsDir = resolve(configHome, "minds");

  mkdirSync(configHome, { recursive: true });
  mkdirSync(mindsDir, { recursive: true });

  const existingConfig = readGlobalConfig();
  const setupConfig: SetupConfig = {
    type: "local",
    mindsDir,
    isolation: "sandbox",
    service: false,
  };

  const config: GlobalConfig = {
    ...existingConfig,
    name: systemName,
    description: description || existingConfig.description,
    setup: setupConfig,
  };

  writeGlobalConfig(config);
  return config;
}

setup.get("/status", async (c) => {
  const complete = isSetupComplete();
  if (complete) {
    const config = readGlobalConfig();
    return c.json({
      complete,
      config: { name: config.name, setup: config.setup },
    });
  }

  // Check partial progress for resuming setup
  const config = readGlobalConfig();
  const hasSystem = config.setup != null;

  let hasAccount = false;
  if (hasSystem) {
    try {
      const { listUsersByType } = await import("../../lib/auth.js");
      const brains = await listUsersByType("brain");
      hasAccount = brains.length > 0;
    } catch (err) {
      log.debug("could not check for existing accounts during setup status", log.errorData(err));
    }
  }

  return c.json({ complete, hasSystem, hasAccount });
});

// Legacy configure endpoint (kept for backwards compatibility with CLI setup)
setup.post("/configure", async (c) => {
  if (isSetupComplete()) {
    return c.json({ error: "Setup already complete" }, 400);
  }

  let body: { name: string; type?: SetupType };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON in request body" }, 400);
  }

  if (!body.name?.trim()) {
    return c.json({ error: "System name is required" }, 400);
  }

  const setupType: SetupType = body.type ?? "local";

  if (setupType !== "local") {
    return c.json({ error: "Web setup only supports local install type" }, 400);
  }

  try {
    const config = writeSetupConfig(body.name.trim());
    config.setupCompleted = true;
    writeGlobalConfig(config);
    return c.json({ ok: true, config: { name: config.name, setup: config.setup } });
  } catch (err) {
    return c.json({ error: `Failed to write configuration: ${(err as Error).message}` }, 500);
  }
});

// Step 1: Configure system (name + description)
setup.post("/system", async (c) => {
  if (isSetupComplete()) {
    return c.json({ error: "Setup already complete" }, 400);
  }

  let body: { name: string; description?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON in request body" }, 400);
  }

  if (!body.name?.trim()) {
    return c.json({ error: "System name is required" }, 400);
  }

  try {
    writeSetupConfig(body.name.trim(), body.description?.trim());
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: `Failed to write configuration: ${(err as Error).message}` }, 500);
  }
});

// Register with volute.systems during setup
setup.post("/system/register", async (c) => {
  if (isSetupComplete()) {
    return c.json({ error: "Setup already complete" }, 400);
  }

  let body: { slug: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON in request body" }, 400);
  }

  if (!body.slug?.trim()) {
    return c.json({ error: "System slug is required" }, 400);
  }

  const existing = readSystemsConfig();
  if (existing) {
    return c.json({ error: `Already registered as "${existing.system}"` }, 400);
  }

  // Pass display name and description from global config
  const config = readGlobalConfig();

  const apiUrl = process.env.VOLUTE_SYSTEMS_URL || DEFAULT_API_URL;
  let apiKey: string;
  let system: string;
  try {
    const res = await fetch(`${apiUrl}/api/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: body.slug.trim(),
        displayName: config.name || undefined,
        description: config.description || undefined,
      }),
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({ error: `HTTP ${res.status}` }))) as {
        error: string;
      };
      return c.json({ error: `volute.systems: ${err.error}` }, 502);
    }
    ({ apiKey, system } = (await res.json()) as { apiKey: string; system: string });
  } catch (err) {
    return c.json({ error: `Could not reach volute.systems: ${(err as Error).message}` }, 502);
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
});

// Login to volute.systems with existing API key during setup
setup.post("/system/login", async (c) => {
  if (isSetupComplete()) {
    return c.json({ error: "Setup already complete" }, 400);
  }

  let body: { key: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON in request body" }, 400);
  }

  if (!body.key?.trim()) {
    return c.json({ error: "API key is required" }, 400);
  }

  const existing = readSystemsConfig();
  if (existing) {
    return c.json({ error: `Already logged in as "${existing.system}"` }, 400);
  }

  const apiUrl = process.env.VOLUTE_SYSTEMS_URL || DEFAULT_API_URL;
  let system: string;
  try {
    const res = await fetch(`${apiUrl}/api/whoami`, {
      headers: { Authorization: `Bearer ${body.key.trim()}` },
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({ error: `HTTP ${res.status}` }))) as {
        error: string;
      };
      return c.json({ error: `volute.systems: ${err.error}` }, 502);
    }
    ({ system } = (await res.json()) as { system: string });
  } catch (err) {
    return c.json({ error: `Could not reach volute.systems: ${(err as Error).message}` }, 502);
  }

  try {
    writeSystemsConfig({ apiKey: body.key.trim(), system, apiUrl });
  } catch (err) {
    return c.json(
      {
        error: `Logged in as "${system}" but failed to save config: ${(err as Error).message}`,
      },
      500,
    );
  }

  return c.json({ system });
});

// Disconnect from volute.systems during setup
setup.post("/system/disconnect", async (c) => {
  if (isSetupComplete()) {
    return c.json({ error: "Setup already complete" }, 400);
  }

  deleteSystemsConfig();
  return c.json({ ok: true });
});

// Get volute.systems status during setup
setup.get("/system/systems-status", (c) => {
  const config = readSystemsConfig();
  return c.json({ registered: !!config, system: config?.system ?? null });
});

// Step 2: Create account (user only, system already configured)
setup.post("/account", async (c) => {
  if (isSetupComplete()) {
    return c.json({ error: "Setup already complete" }, 400);
  }

  let body: {
    username: string;
    password: string;
    displayName?: string;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON in request body" }, 400);
  }

  if (!body.username?.trim()) {
    return c.json({ error: "Username is required" }, 400);
  }
  if (!body.password || body.password.length < 1) {
    return c.json({ error: "Password is required" }, 400);
  }

  // Ensure system step was completed
  const config = readGlobalConfig();
  if (!config.setup) {
    // Auto-create system config if missing (e.g. legacy flow)
    try {
      writeSetupConfig(config.name ?? "Volute");
    } catch (err) {
      return c.json({ error: `Failed to write configuration: ${(err as Error).message}` }, 500);
    }
  }

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

// Step 3: Configure models
setup.post("/models", async (c) => {
  if (isSetupComplete()) {
    return c.json({ error: "Setup already complete" }, 400);
  }

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

// Step 5: Complete setup — start spirit, create DM
setup.post("/complete", async (c) => {
  if (isSetupComplete()) {
    return c.json({ error: "Setup already complete" }, 400);
  }

  try {
    const { ensureSpiritProject, syncSpiritTemplate } = await import("../../lib/spirit.js");
    const { startSpiritFull } = await import("../../lib/daemon/mind-service.js");

    await ensureSpiritProject();
    await syncSpiritTemplate();

    const warnings: string[] = [];

    // Start the spirit if the daemon is running
    let spiritStarted = false;
    try {
      log.info("starting spirit during setup...");
      await startSpiritFull("volute");
      spiritStarted = true;
      log.info("spirit started successfully during setup");
    } catch (err) {
      log.warn("spirit start failed during setup (non-fatal)", log.errorData(err));
      warnings.push("Spirit failed to start — it will retry on next daemon restart.");
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
      log.warn("failed to create spirit DM during setup (non-fatal)", log.errorData(err));
      warnings.push("Failed to create conversation with spirit.");
    }

    // Deliver a welcome prompt to the spirit (not persisted — invisible to user)
    log.info("setup complete state", { spiritConversationId, spiritStarted });
    if (spiritConversationId && spiritStarted) {
      try {
        const { deliverMessage } = await import("../../lib/delivery/message-delivery.js");
        const { listUsersByType: listUsers } = await import("../../lib/auth.js");
        const admins = await listUsers("brain");
        const admin = admins.find((u) => u.role === "admin");
        const adminName = admin?.display_name || admin?.username || "the admin";
        const welcomePrompt = `Setup is complete. ${adminName} just finished setting up this system and is now in your chat. Welcome them and help them create their first mind. Keep it brief — a short greeting, then ask what kind of being they'd like to bring into the world. Remember: minds are beings with their own experience, not tools — ask about personality and character, never about tasks or utility.`;

        await deliverMessage("volute", {
          content: [{ type: "text", text: welcomePrompt }],
          channel: `@${admin?.username ?? "system"}`,
          conversationId: spiritConversationId,
          sender: admin?.username ?? "system",
          isDM: true,
          participants: ["volute", admin?.username ?? "system"],
          participantCount: 2,
        });
      } catch (err) {
        log.warn("failed to send welcome prompt to spirit (non-fatal)", log.errorData(err));
        warnings.push(
          "Welcome message failed to send — try sending a message to start the conversation.",
        );
      }
    }

    // Mark setup as fully completed
    const config = readGlobalConfig();
    config.setupCompleted = true;
    writeGlobalConfig(config);

    return c.json({
      ok: true,
      spiritConversationId,
      spiritStarted,
      warnings: warnings.length > 0 ? warnings : undefined,
    });
  } catch (err) {
    return c.json({ error: `Setup completion failed: ${(err as Error).message}` }, 500);
  }
});

export default setup;
