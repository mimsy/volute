import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { csrf } from "hono/csrf";
import { HTTPException } from "hono/http-exception";
import log from "../lib/logger.js";
import { checkForUpdateCached, getCurrentVersion } from "../lib/update-check.js";
import activityRoutes from "./api/activity.js";
import auth from "./api/auth.js";
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
import variants from "./api/variants.js";
import voluteChannels from "./api/volute/channels.js";
import chat, { unifiedChatApp } from "./api/volute/chat.js";
import conversations from "./api/volute/conversations.js";
import { authMiddleware } from "./middleware/auth.js";

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
app.use(
  "/api/*",
  cors({
    origin: (origin) => origin,
    allowHeaders: ["Authorization", "Content-Type", "X-Volute-Session"],
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    credentials: true,
  }),
);

// CSRF protection for cookie-based requests. Requests with Bearer auth are exempt
// because Bearer tokens aren't auto-attached by browsers, making CSRF impossible.
app.use("/api/*", async (c, next) => {
  const auth = c.req.header("Authorization");
  if (auth?.startsWith("Bearer ")) return next();
  return csrf()(c, next);
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

// Protected API routes
app.use("/api/activity/*", authMiddleware);
app.use("/api/minds/*", authMiddleware);
app.use("/api/conversations/*", authMiddleware);
app.use("/api/system/*", authMiddleware);
app.use("/api/env/*", authMiddleware);
app.use("/api/prompts/*", authMiddleware);
app.use("/api/skills/*", authMiddleware);
app.use("/api/extensions/*", authMiddleware);
app.use("/api/bridges/*", authMiddleware);
app.use("/api/config/*", authMiddleware);

// v1 API auth
app.use("/api/v1/*", authMiddleware);

// Setup routes (no auth — needed before first user exists)
app.route("/api/setup", setup);

// Config routes (authenticated, no admin required — accessible to minds)
app.route("/api/config", configRoutes);

// Chain route registrations to capture types
const routes = app
  .route("/api/activity", activityRoutes)
  .route("/api/keys", keys)
  .route("/api/auth", auth)
  .route("/api/system", system)
  .route("/api/system", update)
  .route("/api/minds", minds)
  .route("/api/minds", chat)
  .route("/api/minds", schedules)
  .route("/api/minds", logs)
  .route("/api/minds", typing)
  .route("/api/minds", variants)
  .route("/api/minds", fileSharing)
  .route("/api/minds", files)
  .route("/api/minds", channels)
  .route("/api/minds", envRoutes)
  .route("/api/minds", mindSkills)
  .route("/api/minds", conversations)
  .route("/api/env", sharedEnvApp)
  .route("/api/prompts", prompts)
  .route("/api/skills", skills)
  .route("/api/bridges", bridges)
  .route("/api/extensions", extensionsRoutes)
  // v1 API routes
  .route("/api/v1/conversations", v1Conversations)
  .route("/api/v1/events", v1Events)
  .route("/api/v1", unifiedChatApp)
  .route("/api/v1/channels", voluteChannels)
  .route("/api/v1/history", historyRoutes);

// v1 re-mounts of existing modules (not chained to preserve AppType)
app.route("/api/v1/minds", minds);
app.route("/api/v1/minds", chat);
app.route("/api/v1/minds", typing);
app.route("/api/v1/minds", variants);
app.route("/api/v1/minds", files);
app.route("/api/v1/minds", envRoutes);
app.route("/api/v1/minds", mindSkills);
app.route("/api/v1/minds", schedules);
app.route("/api/v1/minds", logs);
app.route("/api/v1/system", system);
app.route("/api/v1/system", update);
app.route("/api/v1/prompts", prompts);
app.route("/api/v1/skills", skills);
app.route("/api/v1/env", sharedEnvApp);
app.route("/api/conversations", v1Conversations);

export default app;
export type AppType = typeof routes;
