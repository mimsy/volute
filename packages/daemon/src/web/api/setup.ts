import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { setCookie } from "hono/cookie";
import { z } from "zod";
import {
  type GlobalConfig,
  getSpiritName,
  isSetupComplete,
  readGlobalConfig,
  type SetupConfig,
  writeGlobalConfig,
} from "../../lib/config/setup.js";
import {
  deleteSystemsConfig,
  readSystemsConfig,
  writeSystemsConfig,
} from "../../lib/config/systems-config.js";
import { notifyExtensionsSpiritReady } from "../../lib/extensions.js";
import { findMind, validateSpiritName, voluteSystemDir } from "../../lib/mind/registry.js";
import { normalizeAvatar } from "../../lib/util/avatar-image.js";
import log from "../../lib/util/logger.js";
import { createSession, SESSION_MAX_AGE } from "../middleware/auth.js";

const DEFAULT_API_URL = "https://volute.systems";

// Schemas enforce the declared body types; the semantic checks each route already
// runs (non-empty-after-trim, spirit-name validation, avatar format) stay inline so
// the accepted set for valid input is unchanged — only malformed bodies now 400
// structurally instead of throwing (which surfaced as a 500) or flowing through.
const systemBodySchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  remote: z.boolean().optional(),
  service: z.boolean().optional(),
  tailscale: z.boolean().optional(),
});
const registerBodySchema = z.object({ slug: z.string() });
const loginBodySchema = z.object({ key: z.string() });
const accountBodySchema = z.object({
  username: z.string(),
  password: z.string(),
  displayName: z.string().optional(),
});
const modelsBodySchema = z.object({
  models: z.array(z.string()),
  spiritModel: z.string(),
  utilityModel: z.string().optional(),
});
const spiritBodySchema = z.object({
  name: z.string(),
  temperament: z.string().optional(),
  description: z.string().optional(),
  avatar: z.string().optional(),
});

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
    setupCompleted: false,
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
  const hasSystem = config.setup != null && !!config.name;

  let hasAccount = false;
  if (hasSystem) {
    try {
      const { listUsersByType } = await import("../../lib/auth.js");
      const brains = await listUsersByType("human");
      hasAccount = brains.length > 0;
    } catch (err) {
      // Falling through with hasAccount:false sends a resumed browser back into
      // the wizard (the #690 dead-end) — make the real failure visible.
      log.error("could not check for existing accounts during setup status", log.errorData(err));
    }
  }

  return c.json({
    complete,
    hasSystem,
    hasAccount,
    setupType: config.setup?.type ?? null,
    spiritName: config.setup?.spiritName ?? null,
  });
});

// Step 1: Configure system (name + description + remote access)
setup.post("/system", zValidator("json", systemBodySchema), async (c) => {
  if (isSetupComplete()) {
    return c.json({ error: "Setup already complete" }, 400);
  }

  const body = c.req.valid("json");

  if (!body.name.trim()) {
    return c.json({ error: "System name is required" }, 400);
  }

  try {
    // If setup config already exists (e.g. from `volute setup --system`), just update name/description
    const existing = readGlobalConfig();
    let config: GlobalConfig;
    if (existing.setup) {
      config = {
        ...existing,
        name: body.name.trim(),
        description: body.description?.trim() || existing.description,
        setupCompleted: false,
      };
    } else {
      config = writeSetupConfig(body.name.trim(), body.description?.trim());
    }

    // Enable remote access: bind to all interfaces (skip if already set, e.g. --system)
    if (body.remote && !config.hostname) {
      config.hostname = "0.0.0.0";
    }

    // Tailscale
    if (body.tailscale) {
      config.tailscale = true;
    }

    // Service preference (applied during /complete for local installs)
    if (body.service && config.setup) {
      config.setup.service = true;
    }

    writeGlobalConfig(config);
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: `Failed to write configuration: ${(err as Error).message}` }, 500);
  }
});

// Register with volute.systems during setup
setup.post("/system/register", zValidator("json", registerBodySchema), async (c) => {
  if (isSetupComplete()) {
    return c.json({ error: "Setup already complete" }, 400);
  }

  const body = c.req.valid("json");

  if (!body.slug.trim()) {
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
setup.post("/system/login", zValidator("json", loginBodySchema), async (c) => {
  if (isSetupComplete()) {
    return c.json({ error: "Setup already complete" }, 400);
  }

  const body = c.req.valid("json");

  if (!body.key.trim()) {
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
setup.post("/account", zValidator("json", accountBodySchema), async (c) => {
  if (isSetupComplete()) {
    return c.json({ error: "Setup already complete" }, 400);
  }

  const body = c.req.valid("json");

  const { validateUsername } = await import("../../lib/auth.js");
  const invalidName = validateUsername(body.username.trim());
  if (invalidName) return c.json({ error: invalidName }, 400);
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
setup.post("/models", zValidator("json", modelsBodySchema), async (c) => {
  if (isSetupComplete()) {
    return c.json({ error: "Setup already complete" }, 400);
  }

  const body = c.req.valid("json");

  if (body.models.length === 0) {
    return c.json({ error: "At least one model must be selected" }, 400);
  }
  if (!body.spiritModel.trim()) {
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

// Step 4: Name the spirit
setup.post("/spirit", zValidator("json", spiritBodySchema), async (c) => {
  if (isSetupComplete()) {
    return c.json({ error: "Setup already complete" }, 400);
  }

  const body = c.req.valid("json");

  const name = body.name.trim();
  const nameErr = validateSpiritName(name);
  if (nameErr) {
    return c.json({ error: nameErr }, 400);
  }

  const config = readGlobalConfig();
  if (!config.setup) {
    return c.json({ error: "Complete the system step first" }, 400);
  }

  // A mind already holding this name would collide with the spirit's registry row
  const existing = await findMind(name);
  if (existing && existing.mindType !== "spirit") {
    return c.json({ error: `A mind named "${name}" already exists` }, 400);
  }

  config.setup.spiritName = name;
  const temperament = body.temperament?.trim();
  config.setup.spiritTemperament = temperament || undefined;

  const description = body.description?.trim();
  config.setup.spiritDescription = description || undefined;

  // Each submission is authoritative for the avatar: a previously stashed file is
  // dropped whether the host replaced it or removed it. Runs only after validation
  // so a rejected upload can't destroy the existing stash.
  const clearOldStash = () => {
    if (config.setup?.spiritAvatar) {
      rmSync(resolve(voluteSystemDir(), basename(config.setup.spiritAvatar)), { force: true });
      config.setup.spiritAvatar = undefined;
    }
  };

  if (body.avatar) {
    const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(body.avatar);
    if (!match) {
      return c.json({ error: "Avatar must be a png, jpeg, or webp image" }, 400);
    }
    // Base64 inflates by 4/3 — reject oversized payloads before decoding.
    if (match[2].length > 3 * 1024 * 1024) {
      return c.json({ error: "Avatar must be under 2MB" }, 400);
    }
    let bytes: Buffer = Buffer.from(match[2], "base64");
    if (bytes.length > 2 * 1024 * 1024) {
      return c.json({ error: "Avatar must be under 2MB" }, 400);
    }
    let ext = match[1] === "jpeg" ? "jpg" : match[1];
    // Downscale + re-encode like every other avatar upload; keep original bytes
    // when sharp is unavailable
    const normalized = await normalizeAvatar(bytes);
    if (normalized) {
      bytes = normalized.buffer;
      ext = "webp";
    }
    clearOldStash();
    const filename = `spirit-avatar.${ext}`;
    writeFileSync(resolve(voluteSystemDir(), filename), bytes);
    config.setup.spiritAvatar = filename;
  } else {
    clearOldStash();
  }

  writeGlobalConfig(config);

  return c.json({ ok: true });
});

// Step 5: Complete setup — start spirit, create DM, optionally install service
setup.post("/complete", async (c) => {
  if (isSetupComplete()) {
    return c.json({ error: "Setup already complete" }, 400);
  }

  try {
    const { ensureSpiritProject, syncSpiritTemplate } = await import("../../lib/mind/spirit.js");
    const { startSpiritFull } = await import("../../lib/daemon/mind-service.js");

    await ensureSpiritProject();
    await syncSpiritTemplate();

    // Fresh installs create the spirit here, not at daemon boot — extensions
    // loaded long before this point, so without firing the hook now their
    // spirit bootstrap would wait for a daemon restart to run at all.
    await notifyExtensionsSpiritReady();

    const warnings: string[] = [];

    // Install user-level service if requested in system step (local installs only)
    const config = readGlobalConfig();
    if (config.setup?.service && config.setup?.type === "local") {
      try {
        const { installUserService } = await import("../../lib/config/service-install.js");
        const installed = await installUserService(config.port, config.hostname);
        if (!installed) {
          warnings.push("Service installation is not supported on this platform.");
          config.setup.service = false;
          writeGlobalConfig(config);
        }
      } catch (err) {
        log.warn("user service install failed during setup (non-fatal)", log.errorData(err));
        warnings.push(
          "Failed to install service — you can start Volute manually with `volute up`.",
        );
        config.setup.service = false;
        writeGlobalConfig(config);
      }
    }

    // Start the spirit if the daemon is running
    const spiritName = getSpiritName();
    let spiritStarted = false;
    try {
      log.info("starting spirit during setup...");
      await startSpiritFull(spiritName);
      spiritStarted = true;
      log.info("spirit started successfully during setup");
    } catch (err) {
      log.warn("spirit start failed during setup (non-fatal)", log.errorData(err));
      const reason = err instanceof Error ? err.message : String(err);
      warnings.push(`The spirit couldn't start: ${reason} — it will retry on next daemon restart.`);
    }

    // Create DM between admin and spirit
    let spiritConversationId: string | undefined;
    try {
      const { getOrCreateMindUser, listUsersByType } = await import("../../lib/auth.js");
      const { createConversation, findDMConversation } = await import(
        "../../lib/events/conversations.js"
      );

      const spiritUser = await getOrCreateMindUser(spiritName);

      // Find the admin user (first brain user)
      const brains = await listUsersByType("human");
      const admin = brains.find((u) => u.role === "admin");

      if (admin) {
        const existing = await findDMConversation([admin.id, spiritUser.id]);
        if (existing) {
          spiritConversationId = existing;
        } else {
          const conv = await createConversation({
            participantIds: [admin.id, spiritUser.id],
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
        const admins = await listUsers("human");
        const admin = admins.find((u) => u.role === "admin");
        // The spirit DM (spiritConversationId) is only created when an admin exists,
        // so the real participants are the spirit + admin. Label them accordingly.
        if (admin) {
          const adminName = admin.display_name || admin.username;
          const welcomePrompt = `Setup is complete, and ${adminName} is now in your chat. Greet ${adminName} by name and help them create their first mind. Keep it brief — a short greeting in your own voice, then ask what kind of being they'd like to bring into the world. Remember: minds are beings with their own experience, not tools — ask about personality and character, never about tasks or utility.`;

          await deliverMessage(spiritName, {
            content: [{ type: "text", text: welcomePrompt }],
            channel: `@${admin.username}`,
            conversationId: spiritConversationId,
            sender: admin.username,
            isDM: true,
            participants: [spiritName, admin.username],
            participantCount: 2,
          });
        }
      } catch (err) {
        log.warn("failed to send welcome prompt to spirit (non-fatal)", log.errorData(err));
        warnings.push(
          "Welcome message failed to send — try sending a message to start the conversation.",
        );
      }
    }

    // Mark setup as fully completed
    const finalConfig = readGlobalConfig();
    finalConfig.setupCompleted = true;
    writeGlobalConfig(finalConfig);

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
