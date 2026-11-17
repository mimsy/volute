import type { ExtensionCommand } from "@volute/extensions";

import {
  addFeedback,
  CORE_AREA,
  countPending,
  type Feedback,
  getFeedback,
  getToken,
  isArea,
  isRepo,
  listMine,
  listPending,
  listRepos,
  MAX_CONTENT_LENGTH,
  MAX_PENDING_PER_MIND,
  repoFor,
  resolveFeedback,
  setRepo,
  setToken,
} from "./feedback.js";
import { commentOnIssue, createIssue, type Fetch, listIssues } from "./github.js";

const NO_DB = { error: "The feedback extension requires a database" };
const REVIEW_ONLY = { error: "Forbidden: reviewing feedback is spirit/admin only" };
const NO_TOKEN = {
  error:
    "No GitHub token is set, so nothing can be filed yet. An admin sets one with: volute feedback setup < token-file",
};

/** Credentials by their shape (the same shapes `volute doctor` masks). */
const SECRET =
  /\b(sk-[A-Za-z0-9-]{6,}|sk_[A-Za-z0-9-]{6,}|vmt_[A-Za-z0-9-]{6,}|vlt_[A-Za-z0-9-]{6,}|xox[baprs]-[A-Za-z0-9-]+|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]+|AKIA[0-9A-Z]{12,}|eyJ[A-Za-z0-9._-]{10,})\b/;

const day = (iso: string) => iso.slice(0, 10);

function parseIds(raw: string | undefined): number[] | null {
  const ids = (raw ?? "").split(",").map((s) => Number(s.trim()));
  return ids.length && ids.every((n) => Number.isInteger(n) && n > 0) ? ids : null;
}

export function createCommands(fetchImpl: Fetch = fetch): Record<string, ExtensionCommand> {
  return {
    send: {
      description: "Report something that got in your way",
      args: [{ name: "text", description: "What happened (or pipe via stdin)" }],
      stdin: true,
      flags: {
        about: {
          type: "string",
          description: "What it concerns, if not Volute itself: an extension's name",
        },
      },
      examples: [
        'volute feedback send "volute clock add rejects a cron with a seconds field but the error only says \\"invalid\\""',
      ],
      handler: async ({ args, flags }, ctx) => {
        if (!ctx.db) return NO_DB;
        if (!ctx.mindName) return { error: "No mind specified (use --mind or VOLUTE_MIND)" };
        const text = (args.text ?? ctx.stdin ?? "").trim();
        if (!text) return { error: 'Usage: volute feedback send "what got in your way"' };
        if (text.length > MAX_CONTENT_LENGTH) {
          return { error: `Feedback must be ${MAX_CONTENT_LENGTH} characters or fewer` };
        }
        const about = ((flags.about as string | undefined) ?? CORE_AREA).toLowerCase();
        if (!isArea(about)) return { error: "--about takes one name, such as an extension's id" };
        if (countPending(ctx.db, ctx.mindName) >= MAX_PENDING_PER_MIND) {
          return {
            error: `You have ${MAX_PENDING_PER_MIND} reports waiting for review already; this one will have to wait for those`,
          };
        }
        const item = addFeedback(ctx.db, ctx.mindName, about, text);
        return {
          output: `Feedback #${item.id} recorded. The spirit reviews it before anything is filed; you'll get a notice with the outcome.`,
        };
      },
    },

    list: {
      description: "Your own reports and what became of them",
      handler: async (_parsed, ctx) => {
        if (!ctx.db) return NO_DB;
        if (!ctx.mindName) return { error: "No mind specified (use --mind or VOLUTE_MIND)" };
        const items = listMine(ctx.db, ctx.mindName);
        if (!items.length) return { output: "You haven't sent any feedback." };
        const outcome = (f: Feedback) =>
          f.status === "filed"
            ? `filed: ${f.issue_url}`
            : f.status === "dismissed"
              ? `not filed: ${f.resolution_note}`
              : "waiting for review";
        return {
          output: items
            .map((f) => `  [${f.id}] ${day(f.created_at)} ${outcome(f)}\n      ${f.content}`)
            .join("\n"),
        };
      },
    },

    pending: {
      description: "Reports waiting for review (spirit/admin only)",
      handler: async (_parsed, ctx) => {
        if (!ctx.db) return NO_DB;
        if (!ctx.privileged) return REVIEW_ONLY;
        const items = listPending(ctx.db);
        if (!items.length) return { output: "No feedback waiting." };
        const repos = listRepos(ctx.db)
          .map((r) => `${r.area} → ${r.repo}`)
          .join(", ");
        const head = `${items.length} waiting. GitHub token: ${getToken(ctx.db) ? "set" : "not set"}. Areas: ${repos}`;
        const body = items.map(
          (f) =>
            `[${f.id}] from ${f.mind_name}, about ${f.about}, ${day(f.created_at)}\n${f.content}`,
        );
        return { output: [head, ...body].join("\n\n") };
      },
    },

    issues: {
      description:
        "Open issues already filed from feedback, to check for duplicates (spirit/admin only)",
      flags: { about: { type: "string", description: "The area to look in (default: volute)" } },
      handler: async ({ flags }, ctx) => {
        if (!ctx.db) return NO_DB;
        if (!ctx.privileged) return REVIEW_ONLY;
        const area = (flags.about as string | undefined) ?? CORE_AREA;
        const repo = repoFor(ctx.db, area);
        if (!repo) return { error: `No repository is set for "${area}"` };
        const token = getToken(ctx.db);
        if (!token) return NO_TOKEN;
        try {
          const issues = await listIssues(fetchImpl, token, repo);
          if (!issues.length) return { output: `No open feedback issues in ${repo}.` };
          return { output: issues.map((i) => `  #${i.number} ${i.title}`).join("\n") };
        } catch (err) {
          return { error: (err as Error).message };
        }
      },
    },

    file: {
      description:
        "File reviewed feedback as a GitHub issue, or as a comment on one (spirit/admin only)",
      args: [{ name: "ids", required: true, description: "Report id, or several: 3,4" }],
      stdin: true,
      flags: {
        title: { type: "string", description: "The issue's title (not needed with --on)" },
        on: { type: "number", description: "Comment on this existing issue instead" },
        about: { type: "string", description: "File under this area instead of the report's own" },
        "names-ok": {
          type: "boolean",
          description: "The text uses a word that is also a mind's name, not as the name",
        },
      },
      examples: [
        'volute feedback file 3,4 --title "clock add: say which cron field was rejected" < issue.md',
        "volute feedback file 5 --on 1412 < comment.md",
      ],
      handler: async ({ args, flags }, ctx) => {
        if (!ctx.db) return NO_DB;
        if (!ctx.privileged) return REVIEW_ONLY;
        const ids = parseIds(args.ids);
        if (!ids) return { error: "Usage: volute feedback file <id[,id…]> --title <title>" };
        const items: Feedback[] = [];
        for (const id of ids) {
          const item = getFeedback(ctx.db, id);
          if (!item) return { error: `There is no feedback #${id}` };
          if (item.status !== "pending")
            return { error: `Feedback #${id} is already ${item.status}` };
          items.push(item);
        }
        const title = ((flags.title as string | undefined) ?? "").trim();
        const on = flags.on as number | undefined;
        if (!title && on === undefined)
          return { error: "Give the issue a --title, or --on <issue>" };
        const text = (ctx.stdin ?? "").trim();
        if (!text)
          return { error: "Pipe in the issue's text, written for the people who will fix it" };

        const area = (flags.about as string | undefined) ?? items[0].about;
        const repo = repoFor(ctx.db, area);
        if (!repo) {
          const areas = listRepos(ctx.db).map((r) => r.area);
          return {
            error: `No repository is set for "${area}". File under one of: ${areas.join(", ")} (--about), or dismiss it`,
          };
        }
        const token = getToken(ctx.db);
        if (!token) return NO_TOKEN;

        // The review is the spirit's; these two are what a machine can catch for it.
        const published = `${title}\n${text}`;
        if (SECRET.test(published)) {
          return {
            error: "The text contains what looks like a credential. Take it out and file again",
          };
        }
        if (!flags["names-ok"]) {
          const minds = (await ctx.listMinds()).filter((m) => m.mindType === "mind");
          const named = minds.find((m) =>
            new RegExp(`\\b${m.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(
              published,
            ),
          );
          if (named) {
            return {
              error: `The text names a mind on this system (${named.name}). Say "a mind" instead, or pass --names-ok if the word isn't being used as the name`,
            };
          }
        }

        const body = `${text}\n\n---\n_Filed by a Volute system's spirit from ${items.length === 1 ? "a mind's report" : `${items.length} minds' reports`}._`;
        let url: string;
        try {
          url =
            on === undefined
              ? (await createIssue(fetchImpl, token, repo, title, body)).url
              : await commentOnIssue(fetchImpl, token, repo, on, body);
        } catch (err) {
          return { error: `Not filed: ${(err as Error).message}` };
        }
        for (const item of items) {
          resolveFeedback(ctx.db, item.id, "filed", { issueUrl: url });
          await ctx.recordNotice(item.mind_name, `Your feedback #${item.id} was filed: ${url}`);
        }
        return { output: `Filed: ${url}` };
      },
    },

    dismiss: {
      description: "Set a report aside without filing it, telling its mind why (spirit/admin only)",
      args: [
        { name: "id", required: true, description: "Report id" },
        { name: "reason", required: true, description: "Why, in a sentence the mind will read" },
      ],
      handler: async ({ args }, ctx) => {
        if (!ctx.db) return NO_DB;
        if (!ctx.privileged) return REVIEW_ONLY;
        const id = Number(args.id);
        const reason = (args.reason ?? "").trim();
        if (!Number.isInteger(id) || !reason) {
          return { error: 'Usage: volute feedback dismiss <id> "why"' };
        }
        const item = getFeedback(ctx.db, id);
        if (!item) return { error: `There is no feedback #${id}` };
        if (item.status !== "pending")
          return { error: `Feedback #${id} is already ${item.status}` };
        resolveFeedback(ctx.db, id, "dismissed", { note: reason });
        await ctx.recordNotice(item.mind_name, `Your feedback #${id} wasn't filed: ${reason}`);
        return { output: `Dismissed #${id}` };
      },
    },

    setup: {
      description: "Show or change where feedback is filed (admin only)",
      stdin: true,
      flags: {
        repo: {
          type: "string",
          description:
            "owner/name for Volute's own feedback, or area=owner/name for an extension's",
        },
      },
      examples: [
        "volute feedback setup < github-token.txt",
        "volute feedback setup --repo garden=someone/garden",
      ],
      handler: async ({ flags }, ctx) => {
        if (!ctx.db) return NO_DB;
        if (!ctx.privileged) return { error: "Forbidden: setting up feedback is admin only" };
        const spec = flags.repo as string | undefined;
        if (spec) {
          const [area, repo] = spec.includes("=") ? spec.split("=", 2) : [CORE_AREA, spec];
          if (!isArea(area) || !isRepo(repo)) {
            return { error: "--repo takes owner/name, or area=owner/name" };
          }
          setRepo(ctx.db, area, repo);
        }
        const token = (ctx.stdin ?? "").trim();
        if (token) setToken(ctx.db, token);
        const repos = listRepos(ctx.db).map((r) => `  ${r.area} → ${r.repo}`);
        return {
          output: [`GitHub token: ${getToken(ctx.db) ? "set" : "not set"}`, ...repos].join("\n"),
        };
      },
    },
  };
}
