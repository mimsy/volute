import type { ExtensionContext } from "@volute/extensions";
import { Hono } from "hono";

import {
  addPlanMessage,
  finishPlan,
  getActivePlan,
  listPlans,
  logProgress,
  startPlan,
} from "./plans.js";

function resolveUserId(c: {
  get: (key: string) => unknown;
}): { id: number; username: string; role?: string; user_type?: string } | null {
  const user = c.get("user") as
    | { id: number; username: string; role?: string; user_type?: string }
    | undefined;
  if (!user || user.id === 0) return null;
  return user;
}

async function parseJson<T>(c: { req: { json: () => Promise<unknown> } }): Promise<T | null> {
  try {
    return (await c.req.json()) as T;
  } catch {
    return null;
  }
}

export function createRoutes(ctx: ExtensionContext): Hono {
  if (!ctx.db) throw new Error("Plan extension requires a database");
  const db = ctx.db;
  const { getUser } = ctx;

  const app = new Hono()
    // Get current active plan + logs + messages
    .get("/current", async (c) => {
      const plan = await getActivePlan(db, getUser);
      if (!plan) return c.json(null);
      return c.json(plan);
    })

    // List all plans
    .get("/", async (c) => {
      const status = c.req.query("status");
      const rawLimit = c.req.query("limit");
      const rawOffset = c.req.query("offset");
      const limit = rawLimit ? parseInt(rawLimit, 10) : undefined;
      const offset = rawOffset ? parseInt(rawOffset, 10) : undefined;
      if (
        (limit !== undefined && Number.isNaN(limit)) ||
        (offset !== undefined && Number.isNaN(offset))
      ) {
        return c.json({ error: "Invalid limit or offset parameter" }, 400);
      }
      const plans = await listPlans(db, getUser, { status: status ?? undefined, limit, offset });
      return c.json(plans);
    })

    // Start new plan (spirit/admin only)
    .post("/", async (c) => {
      const actor = resolveUserId(c);
      if (!actor) return c.json({ error: "Unauthorized" }, 401);
      if (actor.role !== "admin" && actor.user_type !== "mind") {
        return c.json({ error: "Only spirit or admin can start plans" }, 403);
      }

      const body = await parseJson<{ title?: string; description?: string }>(c);
      if (!body) return c.json({ error: "Invalid JSON body" }, 400);
      if (!body.title) return c.json({ error: "title is required" }, 400);

      const plan = await startPlan(db, getUser, actor.id, body.title, body.description ?? "");

      ctx.publishActivity({
        type: "plan_started",
        mind: actor.username,
        summary: `${actor.username} started plan: "${body.title}"`,
        metadata: { planId: plan.id, title: body.title },
      });

      return c.json(plan, 201);
    })

    // Post a plan message
    .post("/:id{[0-9]+}/message", async (c) => {
      const actor = resolveUserId(c);
      if (!actor) return c.json({ error: "Unauthorized" }, 401);

      const planId = parseInt(c.req.param("id"), 10);
      if (Number.isNaN(planId)) return c.json({ error: "Invalid plan ID" }, 400);

      const body = await parseJson<{ content?: string }>(c);
      if (!body) return c.json({ error: "Invalid JSON body" }, 400);
      if (!body.content) return c.json({ error: "content is required" }, 400);

      const msg = addPlanMessage(db, planId, body.content);

      ctx.publishActivity({
        type: "plan_message",
        mind: actor.username,
        summary: `Plan message: "${body.content.slice(0, 100)}"`,
        metadata: { planId, messageId: msg.id },
      });

      return c.json(msg, 201);
    })

    // Log progress on a plan
    .post("/:id{[0-9]+}/log", async (c) => {
      const actor = resolveUserId(c);
      if (!actor) return c.json({ error: "Unauthorized" }, 401);

      const planId = parseInt(c.req.param("id"), 10);
      if (Number.isNaN(planId)) return c.json({ error: "Invalid plan ID" }, 400);

      const body = await parseJson<{ content?: string }>(c);
      if (!body) return c.json({ error: "Invalid JSON body" }, 400);
      if (!body.content) return c.json({ error: "content is required" }, 400);

      const log = logProgress(db, planId, actor.username, body.content);

      ctx.publishActivity({
        type: "plan_progress",
        mind: actor.username,
        summary: `${actor.username} logged progress: "${body.content.slice(0, 100)}"`,
        metadata: { planId, logId: log.id },
      });

      return c.json(log, 201);
    })

    // Finish the current plan
    .patch("/:id{[0-9]+}/finish", async (c) => {
      const actor = resolveUserId(c);
      if (!actor) return c.json({ error: "Unauthorized" }, 401);
      if (actor.role !== "admin" && actor.user_type !== "mind") {
        return c.json({ error: "Only spirit or admin can finish plans" }, 403);
      }

      const planId = parseInt(c.req.param("id"), 10);
      if (Number.isNaN(planId)) return c.json({ error: "Invalid plan ID" }, 400);

      const body = await parseJson<{ message?: string }>(c);
      const message = body?.message;

      const ok = finishPlan(db, planId, message);
      if (!ok) return c.json({ error: "Plan not found" }, 404);

      ctx.publishActivity({
        type: "plan_finished",
        mind: actor.username,
        summary: `${actor.username} finished a plan`,
        metadata: { planId },
      });

      return c.json({ ok: true });
    })

    // Feed endpoint
    .get("/feed", async (c) => {
      const rawLimit = c.req.query("limit");
      const limit = rawLimit ? parseInt(rawLimit, 10) : 5;
      if (Number.isNaN(limit)) return c.json({ error: "Invalid limit parameter" }, 400);
      const plans = await listPlans(db, getUser, { limit });
      return c.json(
        plans.map((p) => ({
          id: `plan-${p.id}`,
          title: p.title,
          url: `/plan`,
          date: p.created_at,
          author: p.set_by_username,
          bodyHtml: p.description || `<em>${p.status}</em>`,
          icon: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6"/><path d="M8 4v4l2.5 2.5"/></svg>',
          color: "blue",
        })),
      );
    });

  return app;
}
