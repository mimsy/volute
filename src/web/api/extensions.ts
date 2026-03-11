import { Hono } from "hono";
import { getLoadedExtensions } from "../../lib/extensions.js";
import type { AuthEnv } from "../middleware/auth.js";

const app = new Hono<AuthEnv>().get("/", (c) => {
  return c.json(getLoadedExtensions());
});

export default app;
