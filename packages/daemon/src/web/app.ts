import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { csrf } from "hono/csrf";
import { HTTPException } from "hono/http-exception";
import { normalizeTrailingSlash } from "../lib/extensions.js";
import { checkForUpdateCached, getCurrentVersion } from "../lib/update-check.js";
import log from "../lib/util/logger.js";
import activityRoutes from "./api/activity.js";
import auth from "./api/auth.js";
import backupRoutes from "./api/backup.js";
import bridges from "./api/bridges.js";
import channels from "./api/channels.js";
import configRoutes from "./api/config.js";
import envRoutes, { sharedEnvApp } from "./api/env.js";
import extensionsRoutes from "./api/extensions.js";
import fileSharing from "./api/file-sharing.js";
import files from "./api/files.js";
import historyRoutes from "./api/history.js";
import keys from "./api/keys.js";
import logs from "./api/logs.js";
import mindSkills from "./api/mind-skills.js";
import minds from "./api/minds.js";
import prompts from "./api/prompts.js";
import schedules from "./api/schedules.js";
import setup from "./api/setup.js";
import skills from "./api/skills.js";
import system from "./api/system.js";
import typing from "./api/typing.js";
import update from "./api/update.js";
import v1Conversations from "./api/v1/conversations.js";
import v1Events from "./api/v1/events.js";
import v1Feed from "./api/v1/feed.js";
import variants from "./api/variants.js";
import voluteChannels from "./api/volute/channels.js";
import chat, { chatApp } from "./api/volute/chat.js";
import conversations from "./api/volute/conversations.js";
import { type AuthEnv, authMiddleware } from "./middleware/auth.js";

const httpLog = log.child("http");

const app = new Hono();

// Global error handler
app.onError((err, c) => {
  if (err instanceof HTTPException) {
    return err.getResponse();
  }
  log.error("unhandled error", {
    path: c.req.path,
    method: c.req.method,
    error: err.stack ?? err.message,
  });
  return c.json({ error: "Internal server error" }, 500);
});

app.notFound((c) => {
  return c.json({ error: "Not found" }, 404);
});

// Request logging
app.use("*", async (c, next) => {
  const start = Date.now();
  await next();
  const duration = Date.now() - start;
  const data = { method: c.req.method, path: c.req.path, status: c.res.status, duration };
  if (c.res.status >= 400) {
    httpLog.warn("request error", data);
  } else {
    httpLog.debug("request", data);
  }
});

// Body size limit (10MB — generous for image uploads)
app.use("/api/*", bodyLimit({ maxSize: 10 * 1024 * 1024 }));

// CORS for remote UI clients using Bearer auth (service worker proxy, CLI, Electron).
// credentials: false because remote clients use Bearer tokens, not cookies.
// This prevents cross-origin cookie-based attacks while allowing Bearer auth.
app.use(
  "/api/*",
  cors({
    origin: (origin) => origin,
    allowHeaders: ["Authorization", "Content-Type", "X-Volute-Thread"],
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    credentials: false,
  }),
);

// CSRF protection for cookie-based requests. Requests with Bearer auth are exempt
// because Bearer tokens aren't auto-attached by browsers, making CSRF impossible.
const csrfMiddleware = csrf();
app.use("/api/*", async (c, next) => {
  const auth = c.req.header("Authorization");
  if (auth?.startsWith("Bearer ") && auth.length > 7) return next();
  return csrfMiddleware(c, next);
});

// Daemon health (unauthenticated)
app.get("/api/health", (c) => {
  let version = "unknown";
  let cached: ReturnType<typeof checkForUpdateCached> = null;
  try {
    version = getCurrentVersion();
    cached = checkForUpdateCached();
  } catch (err) {
    log.warn("health check error", { error: (err as Error).message });
  }
  return c.json({
    ok: true,
    version,
    ...(cached?.updateAvailable ? { updateAvailable: true, latest: cached.latest } : {}),
  });
});

// Extension routes 404 on a trailing slash without this (#792).
app.use("/api/ext/*", normalizeTrailingSlash(app));

// Protected API routes. The canonical surface is /api/v1/*; the remaining bare
// /api/* namespaces below are routes that were never dual-mounted under v1
// (admin/system tooling + the mind-scoped file-sharing/channels/conversations
// modules), plus the pre-auth /api/setup and /api/auth handled elsewhere.
app.use("/api/activity/*", authMiddleware);
app.use("/api/minds/*", authMiddleware);
app.use("/api/extensions/*", authMiddleware);
app.use("/api/bridges/*", authMiddleware);
app.use("/api/config/*", authMiddleware);
app.use("/api/backup/*", authMiddleware);

// v1 API auth
app.use("/api/v1/*", authMiddleware);

// Setup routes (no auth — needed before first user exists)
app.route("/api/setup", setup);

// Config routes (authenticated, no admin required — accessible to minds)
app.route("/api/config", configRoutes);

// The canonical /api/v1 surface, composed as a single sub-app mounted once. This
// keeps AppType's per-module route schemas merged under one `v1` key rather than
// piling every module directly onto the root app — the latter overwhelms Hono's
// RPC type merge and silently collapses `AppType["api"]["v1"]` to a partial type,
// breaking the CLI's typed client.
const v1 = new Hono<AuthEnv>()
  .route("/system", system)
  .route("/system", update)
  .route("/minds", minds)
  .route("/minds", chat)
  .route("/minds", schedules)
  .route("/minds", logs)
  .route("/minds", typing)
  .route("/minds", variants)
  .route("/minds", files)
  .route("/minds", envRoutes)
  .route("/minds", mindSkills)
  .route("/env", sharedEnvApp)
  .route("/prompts", prompts)
  .route("/skills", skills)
  .route("/conversations", v1Conversations)
  .route("/events", v1Events)
  .route("/feed", v1Feed)
  .route("/chat", chatApp)
  .route("/channels", voluteChannels)
  .route("/history", historyRoutes);

// Single chained registration — one mount per module, so AppType captures the
// whole surface with no un-chained duplicates. The canonical prefix is /api/v1;
// the bare /api mounts below are the modules that never had a v1 alias (admin
// tooling + the mind-scoped file-sharing/channels/conversations routes).
const routes = app
  .route("/api/activity", activityRoutes)
  .route("/api/keys", keys)
  .route("/api/auth", auth)
  .route("/api/backup", backupRoutes)
  .route("/api/bridges", bridges)
  .route("/api/extensions", extensionsRoutes)
  // Mind-scoped modules that stay on the bare /api prefix (no v1 alias existed).
  .route("/api/minds", fileSharing)
  .route("/api/minds", channels)
  .route("/api/minds", conversations)
  // v1 API — the canonical surface.
  .route("/api/v1", v1);

export default app;
export type AppType = typeof routes;
