import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { csrf } from "hono/csrf";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { MindManagerNotReadyError } from "../lib/daemon/mind-manager.js";
import { normalizeTrailingSlash } from "../lib/extensions.js";
import { checkForUpdateCached, getCurrentVersion } from "../lib/update-check.js";
import log from "../lib/util/logger.js";
import auth from "./api/auth.js";
import backupRoutes from "./api/backup.js";
import bridges from "./api/bridges.js";
import channels from "./api/channels.js";
import chat, { chatApp } from "./api/chat.js";
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
import v1Usage from "./api/v1/usage.js";
import variants from "./api/variants.js";
import voluteChannels from "./api/volute/channels.js";
import conversations from "./api/volute/conversations.js";
import { type AuthEnv, authMiddleware } from "./middleware/auth.js";

const httpLog = log.child("http");

const app = new Hono();

// Global error handler
app.onError((err, c) => {
  if (err instanceof HTTPException) {
    return err.getResponse();
  }
  // The server binds before initMindManager() runs, so any route that needs the
  // mind manager can be reached during startup. That is readiness, not failure:
  // answer 503 "starting" once, here, rather than logging an unhandled error and
  // returning a 500 the caller reads as a real fault (#1050). One conversion point
  // covers every route that reaches getMindManager(), in any router.
  if (err instanceof MindManagerNotReadyError) {
    httpLog.info("request before mind manager init", {
      path: c.req.path,
      method: c.req.method,
    });
    return c.json({ error: "starting" }, 503, { "Retry-After": "1" });
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

// Extension routes 404 on a trailing slash without this (#792). Extension apps
// mount at /api/ext/* dynamically (see extensions.ts), outside the /api/v1 surface,
// so this normalizer stays on the bare /api/ext prefix.
app.use("/api/ext/*", normalizeTrailingSlash(app));

// Authentication for the canonical /api/v1 surface. A few sub-surfaces were
// unauthenticated at their former bare mounts and must stay reachable without a
// session — exempt them so this move doesn't silently gate them:
//   /api/v1/setup — first-run setup, runs before the first user exists
//   /api/v1/auth  — login/register/me/logout/avatars are public; the protected
//                   routes self-guard via their own authMiddleware (see auth.ts)
//   /api/v1/keys  — public identity-key lookup used for signature verification
// Everything else under /api/v1 requires auth.
const V1_PUBLIC_PREFIXES = ["/api/v1/setup", "/api/v1/auth", "/api/v1/keys"];
app.use(
  "/api/v1/*",
  createMiddleware<AuthEnv>(async (c, next) => {
    const path = c.req.path;
    if (V1_PUBLIC_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`))) {
      return next();
    }
    return authMiddleware(c, next);
  }),
);

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
  // fileSharing must mount before files: the admin file-browser registers the
  // wildcard GET /minds/:name/files/* (files.ts), and Hono dispatches to the
  // first matching route, so any more-specific sibling like GET
  // /minds/:name/files/pending has to be registered first or the wildcard
  // swallows it (#900 re-ordering regression). The admin file-browser wildcard
  // must stay last among /minds/:name/files/* registrants; test/route-shadowing.test.ts guards this.
  .route("/minds", fileSharing)
  .route("/minds", files)
  .route("/minds", envRoutes)
  .route("/minds", mindSkills)
  .route("/minds", channels)
  .route("/minds", conversations)
  .route("/env", sharedEnvApp)
  .route("/prompts", prompts)
  .route("/skills", skills)
  .route("/conversations", v1Conversations)
  .route("/events", v1Events)
  .route("/feed", v1Feed)
  .route("/usage", v1Usage)
  .route("/chat", chatApp)
  .route("/channels", voluteChannels)
  .route("/history", historyRoutes)
  .route("/keys", keys)
  .route("/auth", auth)
  .route("/backup", backupRoutes)
  .route("/bridges", bridges)
  .route("/extensions", extensionsRoutes)
  .route("/config", configRoutes)
  .route("/setup", setup);

// Single chained registration — every module mounted exactly once under the
// canonical /api/v1 prefix, so AppType captures the whole surface with no bare
// /api aliases and no un-chained duplicates. The only bare /api routes that
// remain are /api/health (above) and the /api/ext/* extension mounts.
const routes = app.route("/api/v1", v1);

export default app;
export type AppType = typeof routes;
