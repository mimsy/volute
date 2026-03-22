import type { ExtensionCommand } from "@volute/extensions";

import { completePlan, getActivePlan, listPlans, logProgress, setActivePlan } from "./plans.js";

function getFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx !== -1 && args[idx + 1]) return args[idx + 1];
  return undefined;
}

export function createCommands(): Record<string, ExtensionCommand> {
  return {
    set: {
      description: "Set the active system plan",
      usage: 'volute plan set "title" ["description"]  (description can be piped via stdin)',
      handler: async (args, ctx) => {
        if (!ctx.db) return { error: "Plan extension requires a database" };
        const mindName = ctx.mindName;
        if (!mindName) return { error: "No mind specified (use --mind or VOLUTE_MIND)" };

        const user = await ctx.getUserByUsername(mindName);
        if (!user) return { error: `Unknown mind: ${mindName}` };

        const title = args[0];
        const description = args[1] ?? ctx.stdin ?? "";
        if (!title) return { error: 'Usage: volute plan set "title" ["description"]' };

        const plan = await setActivePlan(ctx.db, ctx.getUser, user.id, title, description);

        ctx.publishActivity({
          type: "plan_set",
          mind: user.username,
          summary: `${user.username} set plan: "${title}"`,
          metadata: { planId: plan.id, title },
        });

        return { output: `Plan set: ${plan.title}` };
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

    complete: {
      description: "Mark the current plan as completed",
      usage: "volute plan complete",
      handler: async (_args, ctx) => {
        if (!ctx.db) return { error: "Plan extension requires a database" };
        const mindName = ctx.mindName;
        if (!mindName) return { error: "No mind specified (use --mind or VOLUTE_MIND)" };

        const plan = await getActivePlan(ctx.db, ctx.getUser);
        if (!plan) return { error: "No active plan" };

        completePlan(ctx.db, plan.id);

        ctx.publishActivity({
          type: "plan_completed",
          mind: mindName,
          summary: `${mindName} completed plan: "${plan.title}"`,
          metadata: { planId: plan.id },
        });

        return { output: `Completed: ${plan.title}` };
      },
    },
  };
}
