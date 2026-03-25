import type { ExtensionCommand } from "@volute/extensions";

import {
  addPlanMessage,
  finishPlan,
  getActivePlan,
  listPlans,
  logProgress,
  startPlan,
} from "./plans.js";

function getFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx !== -1 && args[idx + 1]) return args[idx + 1];
  return undefined;
}

// Announce to the #system channel via the extension context.
// Falls back gracefully when context is unavailable (tests).
async function announceToSystem(
  text: string,
  ctx?: { announceToSystem: (text: string) => Promise<void> },
): Promise<boolean> {
  if (!ctx) return false;
  try {
    await ctx.announceToSystem(text);
    return true;
  } catch (err) {
    console.error("[plan] Failed to announce to system channel:", err);
    return false;
  }
}

export function createCommands(): Record<string, ExtensionCommand> {
  return {
    start: {
      description: "Start a new system plan",
      usage: 'volute plan start "title" "description"  (description can be piped via stdin)',
      handler: async (args, ctx) => {
        if (!ctx.db) return { error: "Plan extension requires a database" };
        const mindName = ctx.mindName;
        if (!mindName) return { error: "No mind specified (use --mind or VOLUTE_MIND)" };

        const user = await ctx.getUserByUsername(mindName);
        if (!user) return { error: `Unknown mind: ${mindName}` };

        const title = args[0];
        const description = args[1] ?? ctx.stdin ?? "";
        if (!title) return { error: 'Usage: volute plan start "title" "description"' };

        const plan = await startPlan(ctx.db, ctx.getUser, user.id, title, description);

        ctx.publishActivity({
          type: "plan_started",
          mind: user.username,
          summary: `${user.username} started plan: "${title}"`,
          metadata: { planId: plan.id, title },
        });

        return { output: `Plan started: ${plan.title}` };
      },
    },

    message: {
      description: "Post a message about the current plan (sent to #system)",
      usage: 'volute plan message "today\'s focus: ..."  (content can be piped via stdin)',
      handler: async (args, ctx) => {
        if (!ctx.db) return { error: "Plan extension requires a database" };
        const mindName = ctx.mindName;
        if (!mindName) return { error: "No mind specified (use --mind or VOLUTE_MIND)" };

        const content = args[0] ?? ctx.stdin;
        if (!content) return { error: 'Usage: volute plan message "your message"' };

        const plan = await getActivePlan(ctx.db, ctx.getUser);
        if (!plan) return { error: "No active plan" };

        const msg = addPlanMessage(ctx.db, plan.id, content);

        ctx.publishActivity({
          type: "plan_message",
          mind: mindName,
          summary: `Plan message: "${content.slice(0, 100)}"`,
          metadata: { planId: plan.id, messageId: msg.id },
        });

        // Announce to #system so all minds see it
        const announced = await announceToSystem(`[Plan: ${plan.title}] ${content}`, ctx);

        return {
          output: announced
            ? "Message posted to #system."
            : "Message logged (system channel unavailable).",
        };
      },
    },

    log: {
      description: "Log progress on the current plan",
      usage: 'volute plan log "progress update"  (content can be piped via stdin)',
      handler: async (args, ctx) => {
        if (!ctx.db) return { error: "Plan extension requires a database" };
        const mindName = ctx.mindName;
        if (!mindName) return { error: "No mind specified (use --mind or VOLUTE_MIND)" };

        const content = args[0] ?? ctx.stdin;
        if (!content) return { error: 'Usage: volute plan log "progress update"' };

        const plan = await getActivePlan(ctx.db, ctx.getUser);
        if (!plan) return { error: "No active plan" };

        const log = logProgress(ctx.db, plan.id, mindName, content);

        ctx.publishActivity({
          type: "plan_progress",
          mind: mindName,
          summary: `${mindName} logged progress: "${content.slice(0, 100)}"`,
          metadata: { planId: plan.id, logId: log.id },
        });

        return { output: "Progress logged." };
      },
    },

    current: {
      description: "Show the current active plan",
      usage: "volute plan current",
      handler: async (_args, ctx) => {
        if (!ctx.db) return { error: "Plan extension requires a database" };

        const plan = await getActivePlan(ctx.db, ctx.getUser);
        if (!plan) return { output: "No active plan." };

        const lines = [
          `# ${plan.title}`,
          "",
          `Set by ${plan.set_by_username} — ${new Date(plan.created_at).toLocaleString()}`,
        ];
        if (plan.description) {
          lines.push("", plan.description);
        }
        if (plan.latestMessage) {
          lines.push("", `## Latest message`, "", plan.latestMessage);
        }
        if (plan.logs.length > 0) {
          lines.push("", "## Progress");
          for (const log of plan.logs) {
            const date = new Date(log.created_at).toLocaleString();
            lines.push(`  ${log.mind_name} (${date}): ${log.content}`);
          }
        }
        return { output: lines.join("\n") };
      },
    },

    history: {
      description: "List past plans",
      usage: "volute plan history [--limit N]",
      handler: async (args, ctx) => {
        if (!ctx.db) return { error: "Plan extension requires a database" };

        const limit = parseInt(getFlag(args, "--limit") ?? "10", 10);
        const plans = await listPlans(ctx.db, ctx.getUser, { limit });

        if (plans.length === 0) return { output: "No plans found." };

        const lines = plans.map((p) => {
          const date = new Date(p.created_at).toLocaleDateString();
          const status = p.status === "active" ? " [active]" : "";
          return `  ${p.title}  (${date}, by ${p.set_by_username})${status}`;
        });
        return { output: lines.join("\n") };
      },
    },

    finish: {
      description: "Finish the current plan with a closing message",
      usage: 'volute plan finish "closing message"  (message can be piped via stdin)',
      handler: async (args, ctx) => {
        if (!ctx.db) return { error: "Plan extension requires a database" };
        const mindName = ctx.mindName;
        if (!mindName) return { error: "No mind specified (use --mind or VOLUTE_MIND)" };

        const plan = await getActivePlan(ctx.db, ctx.getUser);
        if (!plan) return { error: "No active plan" };

        const message = args[0] ?? ctx.stdin ?? "";
        finishPlan(ctx.db, plan.id, message);

        ctx.publishActivity({
          type: "plan_finished",
          mind: mindName,
          summary: `${mindName} finished plan: "${plan.title}"`,
          metadata: { planId: plan.id },
        });

        // Announce to #system
        const announcement = message
          ? `[Plan finished: ${plan.title}] ${message}`
          : `[Plan finished: ${plan.title}]`;
        const announced = await announceToSystem(announcement, ctx);

        const suffix = announced ? "" : " (system channel unavailable)";
        return { output: `Finished: ${plan.title}${suffix}` };
      },
    },
  };
}
