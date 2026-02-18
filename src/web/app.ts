import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { csrf } from "hono/csrf";
import { HTTPException } from "hono/http-exception";
import log from "../lib/logger.js";
import { checkForUpdateCached, getCurrentVersion } from "../lib/update-check.js";
import { authMiddleware } from "./middleware/auth.js";
import auth from "./routes/auth.js";
import channels from "./routes/channels.js";
import connectors from "./routes/connectors.js";
import envRoutes, { sharedEnvApp } from "./routes/env.js";
import files from "./routes/files.js";
import logs from "./routes/logs.js";
import minds from "./routes/minds.js";
import pages from "./routes/pages.js";
import schedules from "./routes/schedules.js";
import system from "./routes/system.js";
import typing from "./routes/typing.js";
import update from "./routes/update.js";
import variants from "./routes/variants.js";
import chat from "./routes/volute/chat.js";
import conversations from "./routes/volute/conversations.js";
import userConversations from "./routes/volute/user-conversations.js";

const app = new Hono();

// Global error handler
app.onError((err, c) => {
  if (err instanceof HTTPException) {
    return err.getResponse();
  }
  log.error("Unhandled error", {
    path: c.req.path,
    method: c.req.method,
    error: err.message,
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
  log.info("request", {
    method: c.req.method,
    path: c.req.path,
    status: c.res.status,
    duration,
  });
});

// Daemon health (unauthenticated)
app.get("/api/health", (c) => {
  let version = "unknown";
  let cached: ReturnType<typeof checkForUpdateCached> = null;
  try {
    version = getCurrentVersion();
    cached = checkForUpdateCached();
  } catch (err) {
    log.error("Health check error", { error: (err as Error).message });
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
app.use("/api/system/*", authMiddleware);
app.use("/api/env/*", authMiddleware);

// Mind pages (public, no auth)
app.route("/pages", pages);

// Chain route registrations to capture types
const routes = app
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
  .route("/api/minds", channels)
  .route("/api/minds", envRoutes)
  .route("/api/minds", conversations)
  .route("/api/env", sharedEnvApp)
  .route("/api/conversations", userConversations);

export default app;
export type AppType = typeof routes;
