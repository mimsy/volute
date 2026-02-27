import { eq } from "drizzle-orm";
import { getDb } from "./db.js";
import { systemPrompts } from "./schema.js";

export type PromptCategory = "creation" | "system" | "mind";

export type PromptMeta = {
  content: string;
  description: string;
  variables: string[];
  category: PromptCategory;
};

export const PROMPT_KEYS = [
  "seed_soul",
  "default_soul",
  "default_memory",
  "sprout_message",
  "restart_message",
  "merge_message",
  "compaction_warning",
  "compaction_instructions",
  "reply_instructions",
  "channel_invite",
  "pre_sleep",
  "wake_summary",
  "wake_trigger_summary",
] as const;

export type PromptKey = (typeof PROMPT_KEYS)[number];

export const PROMPT_DEFAULTS: Record<PromptKey, PromptMeta> = {
  seed_soul: {
    content: `You are \${name}.\n\nYou don't have a soul yet. You're a seed — a new mind in the process of discovering who you are.\n\${description}\nHave a conversation with the human. Explore what kind of mind you want to be. When you're ready, write your SOUL.md and MEMORY.md, then run \`volute mind sprout\` to complete the transformation.\n`,
    description: "SOUL.md for seed minds",
    variables: ["name", "description"],
    category: "creation",
  },
  default_soul: {
    content: `You are {{name}}.\n`,
    description:
      "SOUL.md for sprouted minds. Uses {{name}} placeholder (replaced at creation, not by ${var} system)",
    variables: ["name"],
    category: "creation",
  },
  default_memory: {
    content: "",
    description: "Initial MEMORY.md for new minds",
    variables: [],
    category: "creation",
  },
  sprout_message: {
    content:
      "[system] You've sprouted. You now have full capabilities — connectors, schedules, variants, and the complete volute CLI. Check your new skills for details.",
    description: "Sent when a seed mind sprouts",
    variables: [],
    category: "system",
  },
  restart_message: {
    content: "[system] You have been restarted.",
    description: "Generic restart notification",
    variables: [],
    category: "system",
  },
  merge_message: {
    content: '[system] Variant "${name}" has been merged and you have been restarted.',
    description: "Variant merge notification",
    variables: ["name"],
    category: "system",
  },
  compaction_warning: {
    content: `Context is getting long — compaction is about to summarize this conversation. Before that happens, save anything important to files (MEMORY.md, memory/journal/\${date}.md, etc.) since those survive compaction. Focus on: decisions made, open tasks, and anything you'd need to pick up where you left off.`,
    description: "Pre-compaction save reminder sent to the mind",
    variables: ["date"],
    category: "mind",
  },
  compaction_instructions: {
    content:
      "Preserve your sense of who you are, what matters to you, what happened in this conversation, and the threads of thought and connection you'd want to return to.",
    description: "Custom instructions for the compaction summarizer",
    variables: [],
    category: "mind",
  },
  reply_instructions: {
    content: 'To reply to this message, use: volute send ${channel} "your message"',
    description: "First-message reply hint injected via hook",
    variables: ["channel"],
    category: "mind",
  },
  channel_invite: {
    content: `[Channel Invite]\n\${headers}\n\n[\${sender} — \${time}]\n\${preview}\n\nFurther messages will be saved to \${filePath}\n\nTo accept, add to .config/routes.json:\n  Rule: { "channel": "\${channel}", "session": "\${suggestedSession}" }\n\${batchRecommendation}To respond, use: volute send \${channel} "your message"\nTo reject, delete \${filePath}`,
    description: "New channel notification template",
    variables: [
      "headers",
      "sender",
      "time",
      "preview",
      "filePath",
      "channel",
      "suggestedSession",
      "batchRecommendation",
    ],
    category: "mind",
  },
  pre_sleep: {
    content:
      "It's time to sleep. Save anything important to memory or your journal before resting.\nYou'll wake at ${wakeTime}. ${queuedInfo}",
    description: "Pre-sleep message sent before stopping the mind",
    variables: ["wakeTime", "queuedInfo"],
    category: "system",
  },
  wake_summary: {
    content:
      "Good morning — it's ${currentDate}. You slept from ${sleepTime} to now (${duration}).\n${queuedSummary}",
    description: "Wake-up summary after scheduled sleep",
    variables: ["currentDate", "sleepTime", "duration", "queuedSummary"],
    category: "system",
  },
  wake_trigger_summary: {
    content:
      "You were woken at ${currentDate} by a message on ${triggerChannel}.\nYou've been sleeping since ${sleepTime} (${duration}). ${queuedSummary}\nYou'll go back to sleep after handling this.",
    description: "Wake-up summary when woken by a trigger message",
    variables: ["currentDate", "triggerChannel", "sleepTime", "duration", "queuedSummary"],
    category: "system",
  },
};

function isValidKey(key: string): key is PromptKey {
  return PROMPT_KEYS.includes(key as PromptKey);
}

export function substitute(template: string, vars: Record<string, string>): string {
  return template.replace(/\$\{(\w+)\}/g, (match, name) => {
    return name in vars ? vars[name] : match;
  });
}

/**
 * Get prompt content: DB override if exists, else default. Substitutes ${var} placeholders.
 */
export async function getPrompt(key: PromptKey, vars?: Record<string, string>): Promise<string> {
  if (!isValidKey(key)) return "";

  let content = PROMPT_DEFAULTS[key].content;

  try {
    const db = await getDb();
    const row = await db
      .select({ content: systemPrompts.content })
      .from(systemPrompts)
      .where(eq(systemPrompts.key, key))
      .get();
    if (row) content = row.content;
  } catch (err) {
    console.error(`[prompts] failed to read DB override for "${key}":`, err);
  }

  return vars ? substitute(content, vars) : content;
}

/**
 * Get DB-customized value only. Returns null if not customized.
 */
export async function getPromptIfCustom(key: PromptKey): Promise<string | null> {
  if (!isValidKey(key)) return null;

  try {
    const db = await getDb();
    const row = await db
      .select({ content: systemPrompts.content })
      .from(systemPrompts)
      .where(eq(systemPrompts.key, key))
      .get();
    return row?.content ?? null;
  } catch (err) {
    console.error(`[prompts] failed to check DB customization for "${key}":`, err);
    return null;
  }
}

/** Mind-side prompt keys stamped into prompts.json at creation time. Once stamped, these become mind-owned. */
const MIND_PROMPT_KEYS = PROMPT_KEYS.filter((k) => PROMPT_DEFAULTS[k].category === "mind");

/**
 * Returns mind-side prompt defaults (those stamped into prompts.json), with DB overrides applied.
 */
export async function getMindPromptDefaults(): Promise<Record<string, string>> {
  const result: Record<string, string> = {};

  for (const key of MIND_PROMPT_KEYS) {
    result[key] = PROMPT_DEFAULTS[key].content;
  }

  try {
    const db = await getDb();
    const rows = await db.select().from(systemPrompts).all();
    for (const row of rows) {
      if (MIND_PROMPT_KEYS.includes(row.key as PromptKey)) {
        result[row.key] = row.content;
      }
    }
  } catch (err) {
    console.error("[prompts] failed to read DB overrides for mind prompt defaults:", err);
  }

  return result;
}
