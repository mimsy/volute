import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { csrf } from "hono/csrf";
import { HTTPException } from "hono/http-exception";
import log from "../lib/logger.js";
import { checkForUpdateCached, getCurrentVersion } from "../lib/update-check.js";
import auth from "./api/auth.js";
import channels from "./api/channels.js";
import connectors from "./api/connectors.js";
import envRoutes, { sharedEnvApp } from "./api/env.js";
import fileSharing from "./api/file-sharing.js";
import files from "./api/files.js";
import keys from "./api/keys.js";
import logs from "./api/logs.js";
import mindSkills from "./api/mind-skills.js";
import minds from "./api/minds.js";
import pages from "./api/pages.js";
import prompts from "./api/prompts.js";
import schedules from "./api/schedules.js";
import shared from "./api/shared.js";
import skills from "./api/skills.js";
import system from "./api/system.js";
import typing from "./api/typing.js";
import update from "./api/update.js";
import variants from "./api/variants.js";
import voluteChannels from "./api/volute/channels.js";
import chat, { unifiedChatApp } from "./api/volute/chat.js";
import conversations from "./api/volute/conversations.js";
import userConversations from "./api/volute/user-conversations.js";
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

// Body size limit (10MB — generous for image uploads)
app.use("/api/*", bodyLimit({ maxSize: 10 * 1024 * 1024 }));

// CSRF protection for API mutation requests
app.use("/api/*", csrf());

// Protected API routes
app.use("/api/minds/*", authMiddleware);
app.use("/api/conversations/*", authMiddleware);
app.use("/api/volute/*", authMiddleware);
app.use("/api/system/*", authMiddleware);
app.use("/api/env/*", authMiddleware);
app.use("/api/prompts/*", authMiddleware);
app.use("/api/skills/*", authMiddleware);

// Mind pages (public, no auth)
app.route("/pages", pages);

// Chain route registrations to capture types
const routes = app
  .route("/api/keys", keys)
  .route("/api/auth", auth)
  .route("/api/system", system)
  .route("/api/system", update)
  .route("/api/minds", minds)
  .route("/api/minds", chat)
  .route("/api/minds", connectors)
  .route("/api/minds", schedules)
  .route("/api/minds", logs)
  .route("/api/minds", typing)
  .route("/api/minds", variants)
  .route("/api/minds", files)
  .route("/api/minds", fileSharing)
  .route("/api/minds", channels)
  .route("/api/minds", shared)
  .route("/api/minds", envRoutes)
  .route("/api/minds", mindSkills)
  .route("/api/minds", conversations)
  .route("/api/env", sharedEnvApp)
  .route("/api/prompts", prompts)
  .route("/api/skills", skills)
  .route("/api/conversations", userConversations)
  .route("/api/volute/channels", voluteChannels)
  .route("/api/volute", unifiedChatApp);

export default app;
export type AppType = typeof routes;
