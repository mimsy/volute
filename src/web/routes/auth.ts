import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import {
  approveUser,
  createUser,
  getUser,
  getUserByUsername,
  listPendingUsers,
  listUsers,
  verifyUser,
} from "../../lib/auth.js";
import {
  type AuthEnv,
  authMiddleware,
  createSession,
  deleteSession,
  getSessionUserId,
} from "../middleware/auth.js";

const app = new Hono();

app.post("/register", async (c) => {
  const body = await c.req.json<{ username: string; password: string }>();
  if (!body.username || !body.password) {
    return c.json({ error: "Username and password required" }, 400);
  }

  const existing = getUserByUsername(body.username);
  if (existing) {
    return c.json({ error: "Username already taken" }, 409);
  }

  const user = createUser(body.username, body.password);

  if (user.role === "admin") {
    // Auto-login first user
    const sessionId = createSession(user.id);
    setCookie(c, "molt_session", sessionId, { path: "/", httpOnly: true, sameSite: "Lax" });
  }

  return c.json({ id: user.id, username: user.username, role: user.role });
});

app.post("/login", async (c) => {
  const body = await c.req.json<{ username: string; password: string }>();
  if (!body.username || !body.password) {
    return c.json({ error: "Username and password required" }, 400);
  }

  const user = verifyUser(body.username, body.password);
  if (!user) {
    return c.json({ error: "Invalid credentials" }, 401);
  }

  const sessionId = createSession(user.id);
  setCookie(c, "molt_session", sessionId, { path: "/", httpOnly: true, sameSite: "Lax" });
  return c.json({ id: user.id, username: user.username, role: user.role });
});

app.post("/logout", (c) => {
  const sessionId = getCookie(c, "molt_session");
  if (sessionId) {
    deleteSession(sessionId);
    deleteCookie(c, "molt_session", { path: "/" });
  }
  return c.json({ ok: true });
});

app.get("/me", (c) => {
  const sessionId = getCookie(c, "molt_session");
  if (!sessionId) return c.json({ error: "Not logged in" }, 401);

  const userId = getSessionUserId(sessionId);
  if (userId == null) return c.json({ error: "Not logged in" }, 401);

  const user = getUser(userId);
  if (!user) return c.json({ error: "Not logged in" }, 401);

  return c.json({ id: user.id, username: user.username, role: user.role });
});

// Admin-only routes — use authMiddleware
const admin = new Hono<AuthEnv>();
admin.use(authMiddleware);

admin.get("/users", (c) => {
  const user = c.get("user");
  if (user.role !== "admin") return c.json({ error: "Forbidden" }, 403);
  return c.json(listUsers());
});

admin.get("/users/pending", (c) => {
  const user = c.get("user");
  if (user.role !== "admin") return c.json({ error: "Forbidden" }, 403);
  return c.json(listPendingUsers());
});

admin.post("/users/:id/approve", (c) => {
  const user = c.get("user");
  if (user.role !== "admin") return c.json({ error: "Forbidden" }, 403);
  const id = parseInt(c.req.param("id"), 10);
  approveUser(id);
  return c.json({ ok: true });
});

app.route("/", admin);

export default app;
