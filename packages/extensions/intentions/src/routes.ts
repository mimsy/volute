import type { ExtensionContext } from "@volute/extensions";
import { Hono } from "hono";

import {
  countActive,
  createIntention,
  fulfillIntention,
  getIntention,
  type Intention,
  keepIntention,
  listBoard,
  listMine,
  listReviewDue,
  MAX_ACTIVE_INTENTIONS,
  MAX_CONTENT_LENGTH,
  releaseIntention,
} from "./intentions.js";

type Actor = { id: number; username: string; role?: string; user_type?: string };

function resolveActor(c: { get: (key: string) => unknown }): Actor | null {
  const user = c.get("user") as Actor | undefined;
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

/** Mutation ownership: the mind that holds the intention, or an admin. */
function canManage(actor: Actor, intention: Pick<Intention, "mind_name">): boolean {
  return actor.role === "admin" || actor.username === intention.mind_name;
}

export function createRoutes(ctx: ExtensionContext): Hono {
  if (!ctx.db) throw new Error("Intentions extension requires a database");
  const db = ctx.db;

  const app = new Hono()
    // Board: intentions across all minds (default status=active), any authed caller
    .get("/", async (c) => {
      const mind = c.req.query("mind") ?? undefined;
      const status = c.req.query("status") ?? undefined;
      return c.json(listBoard(db, { mind, status }));
    })

    // Caller's own active intentions — what the pre-prompt hook reads. Never errors
    // for a non-mind caller; just returns nothing to inject.
    .get("/mine", async (c) => {
      const actor = resolveActor(c);
      if (actor?.user_type !== "mind") return c.json([]);
      return c.json(listMine(db, actor.username));
    })

    // Create an intention. The acting identity is always the owner — there's no
    // target-mind field, so "or admin" here just means an admin account can hold
    // intentions of its own, same as a mind.
    .post("/", async (c) => {
      const actor = resolveActor(c);
      if (!actor) return c.json({ error: "Unauthorized" }, 401);
      if (actor.user_type !== "mind" && actor.role !== "admin") {
        return c.json({ error: "Only a mind can hold intentions" }, 403);
      }

      const body = await parseJson<{ content?: string; note?: string; reviewInDays?: number }>(c);
      if (!body) return c.json({ error: "Invalid JSON body" }, 400);
      const content = body.content?.trim();
      if (!content) return c.json({ error: "content is required" }, 400);
      if (content.length > MAX_CONTENT_LENGTH) {
        return c.json({ error: `content must be ${MAX_CONTENT_LENGTH} characters or fewer` }, 400);
      }

      const mindName = actor.username;
      if (countActive(db, mindName) >= MAX_ACTIVE_INTENTIONS) {
        return c.json(
          {
            error: `${mindName} already holds ${MAX_ACTIVE_INTENTIONS} active intentions — fulfill or release one first`,
          },
          400,
        );
      }

      const intention = createIntention(db, mindName, content, body.note, body.reviewInDays);

      ctx.publishActivity({
        type: "intention_set",
        mind: mindName,
        summary: `${mindName} set an intention: "${content}"`,
        metadata: { intentionId: intention.id, url: "/intentions" },
      });

      return c.json(intention, 201);
    })

    // Keep: bump review_at, clear the outreach backoff
    .post("/:id{[0-9]+}/keep", async (c) => {
      const actor = resolveActor(c);
      if (!actor) return c.json({ error: "Unauthorized" }, 401);

      const id = parseInt(c.req.param("id"), 10);
      const existing = getIntention(db, id);
      if (!existing) return c.json({ error: "Intention not found" }, 404);
      if (!canManage(actor, existing)) return c.json({ error: "Forbidden" }, 403);

      const intention = keepIntention(db, id);
      if (!intention) return c.json({ error: "Intention not found" }, 404);
      return c.json(intention);
    })

    // Fulfill
    .post("/:id{[0-9]+}/fulfill", async (c) => {
      const actor = resolveActor(c);
      if (!actor) return c.json({ error: "Unauthorized" }, 401);

      const id = parseInt(c.req.param("id"), 10);
      const existing = getIntention(db, id);
      if (!existing) return c.json({ error: "Intention not found" }, 404);
      if (!canManage(actor, existing)) return c.json({ error: "Forbidden" }, 403);

      const body = await parseJson<{ note?: string }>(c);
      const intention = fulfillIntention(db, id, body?.note);
      if (!intention) return c.json({ error: "Intention not found" }, 404);

      ctx.publishActivity({
        type: "intention_fulfilled",
        mind: existing.mind_name,
        summary: `${existing.mind_name} fulfilled an intention: "${existing.content}"`,
        metadata: { intentionId: id, url: "/intentions" },
      });

      return c.json(intention);
    })

    // Release — letting an intention go is a fine outcome, not a failure
    .post("/:id{[0-9]+}/release", async (c) => {
      const actor = resolveActor(c);
      if (!actor) return c.json({ error: "Unauthorized" }, 401);

      const id = parseInt(c.req.param("id"), 10);
      const existing = getIntention(db, id);
      if (!existing) return c.json({ error: "Intention not found" }, 404);
      if (!canManage(actor, existing)) return c.json({ error: "Forbidden" }, 403);

      const body = await parseJson<{ note?: string }>(c);
      const intention = releaseIntention(db, id, body?.note);
      if (!intention) return c.json({ error: "Intention not found" }, 404);

      ctx.publishActivity({
        type: "intention_released",
        mind: existing.mind_name,
        summary: `${existing.mind_name} released an intention: "${existing.content}"`,
        metadata: { intentionId: id, url: "/intentions" },
      });

      return c.json(intention);
    })

    // Review-due — spirit or admin only. Do NOT use user_type === "mind" as a proxy
    // for "is the spirit": that was the old plan extension's bug, and it granted
    // coordinator powers to every mind on the system. The spirit shares the system
    // user account (role: "system"); gate on that plus "admin", mirroring
    // requireAdminOrSystem in the daemon's own web middleware.
    .get("/review-due", async (c) => {
      const actor = resolveActor(c);
      if (!actor) return c.json({ error: "Unauthorized" }, 401);
      if (actor.role !== "admin" && actor.role !== "system") {
        return c.json({ error: "Forbidden" }, 403);
      }

      const rawNudge = Number(process.env.VOLUTE_INTENTION_NUDGE_DAYS);
      const backoffDays = Number.isFinite(rawNudge) && rawNudge > 0 ? rawNudge : undefined;
      return c.json(listReviewDue(db, backoffDays));
    })

    // Feed endpoint
    .get("/feed", async (c) => {
      const rawLimit = c.req.query("limit");
      const limit = rawLimit ? parseInt(rawLimit, 10) : 8;
      if (Number.isNaN(limit)) return c.json({ error: "Invalid limit parameter" }, 400);
      const intentions = listBoard(db, { limit });
      return c.json(
        intentions.map((i) => ({
          id: `intention-${i.id}`,
          title: i.content,
          url: "/intentions",
          date: i.created_at,
          author: i.mind_name,
          bodyHtml: i.status === "active" ? "" : `<em>${i.status}</em>`,
          icon: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2v3M8 11v3M2 8h3M11 8h3"/><circle cx="8" cy="8" r="2.5"/></svg>',
          color: "purple",
        })),
      );
    });

  return app;
}
