import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
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

const credentialsSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

const app = new Hono();

app.post("/register", zValidator("json", credentialsSchema), async (c) => {
  const { username, password } = c.req.valid("json");

  const existing = await getUserByUsername(username);
  if (existing) {
    return c.json({ error: "Username already taken" }, 409);
  }

  const user = await createUser(username, password);

  if (user.role === "admin") {
    // Auto-login first user
    const sessionId = createSession(user.id);
    setCookie(c, "molt_session", sessionId, { path: "/", httpOnly: true, sameSite: "Lax" });
  }

  return c.json({ id: user.id, username: user.username, role: user.role });
});

app.post("/login", zValidator("json", credentialsSchema), async (c) => {
  const { username, password } = c.req.valid("json");

  const user = await verifyUser(username, password);
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

app.get("/me", async (c) => {
  const sessionId = getCookie(c, "molt_session");
  if (!sessionId) return c.json({ error: "Not logged in" }, 401);

  const userId = getSessionUserId(sessionId);
  if (userId == null) return c.json({ error: "Not logged in" }, 401);

  const user = await getUser(userId);
  if (!user) return c.json({ error: "Not logged in" }, 401);

  return c.json({ id: user.id, username: user.username, role: user.role });
});

// Admin-only routes — use authMiddleware
const admin = new Hono<AuthEnv>();
admin.use(authMiddleware);

admin.get("/users", async (c) => {
  const user = c.get("user");
  if (user.role !== "admin") return c.json({ error: "Forbidden" }, 403);
  return c.json(await listUsers());
});

admin.get("/users/pending", async (c) => {
  const user = c.get("user");
  if (user.role !== "admin") return c.json({ error: "Forbidden" }, 403);
  return c.json(await listPendingUsers());
});

admin.post("/users/:id/approve", async (c) => {
  const user = c.get("user");
  if (user.role !== "admin") return c.json({ error: "Forbidden" }, 403);
  const id = parseInt(c.req.param("id"), 10);
  await approveUser(id);
  return c.json({ ok: true });
});

app.route("/", admin);

export default app;
