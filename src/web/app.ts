import { Hono } from "hono";
import { csrf } from "hono/csrf";
import { HTTPException } from "hono/http-exception";
import log from "../lib/logger.js";
import { authMiddleware } from "./middleware/auth.js";
import agents from "./routes/agents.js";
import auth from "./routes/auth.js";
import chat from "./routes/chat.js";
import conversations from "./routes/conversations.js";
import files from "./routes/files.js";
import logs from "./routes/logs.js";
import system from "./routes/system.js";
import variants from "./routes/variants.js";

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

// CSRF protection for API mutation requests
app.use("/api/*", csrf());

// Protected API routes
app.use("/api/agents/*", authMiddleware);
app.use("/api/system/*", authMiddleware);

// Chain route registrations to capture types
const routes = app
  .route("/api/auth", auth)
  .route("/api/system", system)
  .route("/api/agents", agents)
  .route("/api/agents", chat)
  .route("/api/agents", logs)
  .route("/api/agents", variants)
  .route("/api/agents", files)
  .route("/api/agents", conversations);

export default app;
export type AppType = typeof routes;
