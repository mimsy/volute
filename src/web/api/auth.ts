import { zValidator } from "@hono/zod-validator";
import { readRegistry } from "@volute/shared/registry";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import {
  approveUser,
  changePassword,
  createUser,
  getOrCreateMindUser,
  getUser,
  getUserByUsername,
  listPendingUsers,
  listUsers,
  listUsersByType,
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

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(1),
});

const authenticated = new Hono<AuthEnv>()
  .use(authMiddleware)
  .post("/change-password", zValidator("json", changePasswordSchema), async (c) => {
    const user = c.get("user");
    const { currentPassword, newPassword } = c.req.valid("json");
    const ok = await changePassword(user.id, currentPassword, newPassword);
    if (!ok) return c.json({ error: "Current password is incorrect" }, 400);
    return c.json({ ok: true });
  });

const admin = new Hono<AuthEnv>()
  .use(authMiddleware)
  .get("/users", async (c) => {
    const user = c.get("user");
    if (user.role !== "admin") return c.json({ error: "Forbidden" }, 403);

    // Ensure all registered minds have user records
    const minds = readRegistry();
    for (const mind of minds) {
      await getOrCreateMindUser(mind.name);
    }

    const type = c.req.query("type");
    if (type === "brain" || type === "mind") {
      return c.json(await listUsersByType(type));
    }
    return c.json(await listUsers());
  })
  .get("/users/pending", async (c) => {
    const user = c.get("user");
    if (user.role !== "admin") return c.json({ error: "Forbidden" }, 403);
    return c.json(await listPendingUsers());
  })
  .post("/users/:id/approve", async (c) => {
    const user = c.get("user");
    if (user.role !== "admin") return c.json({ error: "Forbidden" }, 403);
    const id = parseInt(c.req.param("id"), 10);
    await approveUser(id);
    return c.json({ ok: true });
  });

const app = new Hono()
  .post("/register", zValidator("json", credentialsSchema), async (c) => {
    const { username, password } = c.req.valid("json");

    const existing = await getUserByUsername(username);
    if (existing) {
      return c.json({ error: "Username already taken" }, 409);
    }

    const user = await createUser(username, password);

    if (user.role === "admin") {
      // Auto-login first user
      const sessionId = await createSession(user.id);
      setCookie(c, "volute_session", sessionId, { path: "/", httpOnly: true, sameSite: "Lax" });
    }

    return c.json({ id: user.id, username: user.username, role: user.role });
  })
  .post("/login", zValidator("json", credentialsSchema), async (c) => {
    const { username, password } = c.req.valid("json");

    const user = await verifyUser(username, password);
    if (!user) {
      return c.json({ error: "Invalid credentials" }, 401);
    }

    const sessionId = await createSession(user.id);
    setCookie(c, "volute_session", sessionId, { path: "/", httpOnly: true, sameSite: "Lax" });
    return c.json({ id: user.id, username: user.username, role: user.role });
  })
  .post("/logout", async (c) => {
    const sessionId = getCookie(c, "volute_session");
    if (sessionId) {
      await deleteSession(sessionId);
      deleteCookie(c, "volute_session", { path: "/" });
    }
    return c.json({ ok: true });
  })
  .get("/me", async (c) => {
    const sessionId = getCookie(c, "volute_session");
    if (!sessionId) return c.json({ error: "Not logged in" }, 401);

    const userId = await getSessionUserId(sessionId);
    if (userId == null) return c.json({ error: "Not logged in" }, 401);

    const user = await getUser(userId);
    if (!user) return c.json({ error: "Not logged in" }, 401);

    return c.json({ id: user.id, username: user.username, role: user.role });
  })
  .route("/", admin)
  .route("/", authenticated);

export default app;
