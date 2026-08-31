import type { ExtensionCommand } from "@volute/extensions";

import { formatHeldDays } from "./format.js";
import {
  countActive,
  createIntention,
  DEFAULT_BACKOFF_DAYS,
  fulfillIntention,
  getIntention,
  type Intention,
  keepIntention,
  listMine,
  listReviewDue,
  MAX_ACTIVE_INTENTIONS,
  MAX_CONTENT_LENGTH,
  releaseIntention,
} from "./intentions.js";

/** Mutation ownership: the acting mind holds the intention, or is an admin. */
function canManage(
  actor: { username: string; role?: string } | null,
  intention: Pick<Intention, "mind_name">,
): boolean {
  if (!actor) return false;
  return actor.role === "admin" || actor.username === intention.mind_name;
}

export function createCommands(): Record<string, ExtensionCommand> {
  return {
    add: {
      description: "Set a new intention",
      args: [
        {
          name: "content",
          required: true,
          description: "What you're oriented toward (or pipe via stdin)",
        },
      ],
      stdin: true,
      flags: {
        note: {
          type: "string",
          description: "Optional longer-form note (not shown in session context)",
        },
        "review-in": { type: "number", description: "Days until soft review (default 14)" },
      },
      handler: async ({ args, flags }, ctx) => {
        if (!ctx.db) return { error: "Intentions extension requires a database" };
        const mindName = ctx.mindName;
        if (!mindName) return { error: "No mind specified (use --mind or VOLUTE_MIND)" };

        const content = (args.content ?? ctx.stdin ?? "").trim();
        if (!content) return { error: 'Usage: volute intentions add "content"' };
        if (content.length > MAX_CONTENT_LENGTH) {
          return { error: `content must be ${MAX_CONTENT_LENGTH} characters or fewer` };
        }

        if (countActive(ctx.db, mindName) >= MAX_ACTIVE_INTENTIONS) {
          return {
            error: `${mindName} already holds ${MAX_ACTIVE_INTENTIONS} active intentions — fulfill or release one first`,
          };
        }

        const reviewInDays = flags["review-in"] as number | undefined;
        const note = flags.note as string | undefined;
        const intention = createIntention(ctx.db, mindName, content, note, reviewInDays);

        ctx.publishActivity({
          type: "intention_set",
          mind: mindName,
          summary: `${mindName} set an intention: "${content}"`,
          metadata: { intentionId: intention.id, url: "/intentions" },
        });

        return { output: `Intention set: ${intention.content}` };
      },
    },

    list: {
      description: "List active intentions (your own by default)",
      flags: {
        mind: { type: "string", description: "Show another mind's active intentions" },
      },
      handler: async ({ flags }, ctx) => {
        if (!ctx.db) return { error: "Intentions extension requires a database" };
        const target = (flags.mind as string | undefined) ?? ctx.mindName;
        if (!target) return { error: "No mind specified (use --mind or VOLUTE_MIND)" };

        const intentions = listMine(ctx.db, target);
        if (intentions.length === 0) return { output: `No active intentions for ${target}.` };

        const lines = intentions.map((i) => {
          const overdue = i.overdue ? ", review overdue" : "";
          return `  [${i.id}] ${i.content} (${formatHeldDays(i.held_days)}${overdue})`;
        });
        return { output: lines.join("\n") };
      },
    },

    keep: {
      description: "Keep an intention alive, pushing its review date out",
      args: [{ name: "id", required: true, description: "Intention id" }],
      handler: async ({ args }, ctx) => {
        if (!ctx.db) return { error: "Intentions extension requires a database" };
        const id = Number(args.id);
        if (!Number.isFinite(id)) return { error: "Usage: volute intentions keep <id>" };

        const existing = getIntention(ctx.db, id);
        if (!existing) return { error: "Intention not found" };
        const actor = ctx.mindName ? await ctx.getUserByUsername(ctx.mindName) : null;
        if (!canManage(actor, existing)) return { error: "Forbidden" };

        const intention = keepIntention(ctx.db, id);
        if (!intention) return { error: "Intention not found" };
        return { output: `Kept: ${intention.content}` };
      },
    },

    fulfill: {
      description: "Mark an intention fulfilled",
      args: [
        { name: "id", required: true, description: "Intention id" },
        { name: "note", description: "Optional closing note (or pipe via stdin)" },
      ],
      stdin: true,
      handler: async ({ args }, ctx) => {
        if (!ctx.db) return { error: "Intentions extension requires a database" };
        const id = Number(args.id);
        if (!Number.isFinite(id)) return { error: "Usage: volute intentions fulfill <id>" };

        const existing = getIntention(ctx.db, id);
        if (!existing) return { error: "Intention not found" };
        const actor = ctx.mindName ? await ctx.getUserByUsername(ctx.mindName) : null;
        if (!canManage(actor, existing)) return { error: "Forbidden" };

        const note = args.note ?? ctx.stdin;
        const intention = fulfillIntention(ctx.db, id, note);
        if (!intention) return { error: "Intention not found" };

        ctx.publishActivity({
          type: "intention_fulfilled",
          mind: existing.mind_name,
          summary: `${existing.mind_name} fulfilled an intention: "${existing.content}"`,
          metadata: { intentionId: id, url: "/intentions" },
        });

        return { output: `Fulfilled: ${intention.content}` };
      },
    },

    release: {
      description: "Release an intention — letting it go is a fine outcome, not a failure",
      args: [
        { name: "id", required: true, description: "Intention id" },
        { name: "note", description: "Optional closing note (or pipe via stdin)" },
      ],
      stdin: true,
      handler: async ({ args }, ctx) => {
        if (!ctx.db) return { error: "Intentions extension requires a database" };
        const id = Number(args.id);
        if (!Number.isFinite(id)) return { error: "Usage: volute intentions release <id>" };

        const existing = getIntention(ctx.db, id);
        if (!existing) return { error: "Intention not found" };
        const actor = ctx.mindName ? await ctx.getUserByUsername(ctx.mindName) : null;
        if (!canManage(actor, existing)) return { error: "Forbidden" };

        const note = args.note ?? ctx.stdin;
        const intention = releaseIntention(ctx.db, id, note);
        if (!intention) return { error: "Intention not found" };

        ctx.publishActivity({
          type: "intention_released",
          mind: existing.mind_name,
          summary: `${existing.mind_name} released an intention: "${existing.content}"`,
          metadata: { intentionId: id, url: "/intentions" },
        });

        return { output: `Released: ${intention.content}` };
      },
    },

    "review-due": {
      description:
        "List active intentions past review, respecting the outreach backoff (spirit/admin only)",
      handler: async (_parsed, ctx) => {
        if (!ctx.db) return { error: "Intentions extension requires a database" };
        if (!ctx.mindName) return { error: "No mind specified (use --mind or VOLUTE_MIND)" };

        // `ctx.privileged` is the daemon's resolved authority for this request, not
        // the caller's stored role. The spirit's account reads "spirit" on every call,
        // so a role lookup here would hand review-due to a spirit turn that a mind's
        // DM triggered — exactly the confused deputy #433 closes.
        if (!ctx.privileged) {
          return { error: "Forbidden: review-due is spirit/admin only" };
        }

        const rawNudge = Number(process.env.VOLUTE_INTENTION_NUDGE_DAYS);
        const backoffDays =
          Number.isFinite(rawNudge) && rawNudge > 0 ? rawNudge : DEFAULT_BACKOFF_DAYS;
        const due = listReviewDue(ctx.db, backoffDays);
        if (due.length === 0) return { output: "No intentions due for review." };

        const lines = due.map(
          (i) => `  [${i.id}] ${i.mind_name}: ${i.content} (${formatHeldDays(i.held_days)})`,
        );
        return { output: lines.join("\n") };
      },
    },
  };
}
