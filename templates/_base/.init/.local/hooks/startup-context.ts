// Startup context hook — generates orientation context for new sessions.
// Edit this script to customize what you see when your session starts.
// Input: JSON on stdin with { "source": "startup" | "SessionStart" }
// Output: JSON with hookSpecificOutput.additionalContext (for SessionStart hook)
//         or plain text (for direct execution by pi template)

import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const input = await new Promise<string>((resolve) => {
  let data = "";
  process.stdin.on("data", (chunk: Buffer) => {
    data += chunk;
  });
  process.stdin.on("end", () => resolve(data));
});

let source = "startup";
try {
  source = JSON.parse(input).source ?? "startup";
} catch {}

/** Cents, unless a nonzero amount under a cent — which would read as "$0.00". */
function usd(n: number): string {
  return n > 0 && n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

/** How long until an instant, phrased for someone reading it at session start. */
function until(at: number | null | undefined): string {
  if (at == null) return "when the period rolls over";
  const minutes = Math.max(0, Math.round((at - Date.now()) / 60_000));
  if (minutes < 1) return "in under a minute";
  if (minutes < 60) return `in ${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `in about ${hours} hours` : `in about ${Math.round(hours / 24)} days`;
}

/** "day" / "hour" / "90 minutes" — the period a cap is denominated in. */
function periodName(minutes: number | undefined): string {
  if (!minutes || minutes <= 0) return "period";
  if (minutes === 1440) return "day";
  if (minutes === 60) return "hour";
  return `${minutes} minutes`;
}

type Budget = {
  spentUsd?: number;
  capUsd?: number;
  periodMinutes?: number;
  resetAt?: number;
  hasUnpricedTurns?: boolean;
  system?: { spentUsd: number; capUsd: number; resetAt: number } | null;
};

/**
 * One line for the mind's own cap, one for the install-wide budget — each only
 * when it exists. An install-wide cap is named as shared rather than as the mind's
 * own, because a mind held by it has not overspent anything.
 *
 * Unpriced turns count $0, so a period carrying any makes the spend figure a floor
 * rather than a total. Said neutrally: legacy rows are wrong in opposite directions
 * by template, so naming a direction would be false for half of them.
 */
function spendLines(b: Budget): string[] {
  const lines: string[] = [];
  const floor = b.hasUnpricedTurns ? " (a floor — some turns this period couldn't be priced)" : "";
  if (typeof b.capUsd === "number" && b.capUsd > 0) {
    lines.push(
      `Your spend cap is ${usd(b.capUsd)} per ${periodName(b.periodMinutes)}; ` +
        `${usd(b.spentUsd ?? 0)} spent so far${floor}, resetting ${until(b.resetAt)}.`,
    );
  }
  if (b.system) {
    lines.push(
      `This install has a shared budget of ${usd(b.system.capUsd)} per day across every mind here ` +
        `(${usd(b.system.spentUsd)} spent, resetting ${until(b.system.resetAt)}).`,
    );
  }
  return lines;
}

const parts: string[] = [];

// System identity — only the spirit has home/.config/system.json (synced by the
// daemon). It keeps the spirit's system name/description current without the
// daemon rewriting its self-owned SOUL.md. Regular minds fall back to the system
// name the daemon passes in VOLUTE_SYSTEM_NAME, so every mind knows what this
// system is called.
{
  const mindDir = process.env.VOLUTE_MIND_DIR;
  let named = false;
  if (mindDir) {
    try {
      const raw = readFileSync(resolve(mindDir, "home/.config/system.json"), "utf-8");
      const { name, description } = JSON.parse(raw) as { name?: string; description?: string };
      if (name) {
        parts.push(`You are the spirit of ${name}${description ? ` — ${description}` : ""}.`);
        named = true;
      }
    } catch (err: any) {
      // Missing file is the normal case for a regular mind; anything else
      // (unreadable, corrupt JSON) is worth surfacing on stderr.
      if (err?.code !== "ENOENT") {
        console.error(`startup-context: failed to read system.json: ${err?.message ?? err}`);
      }
    }
  }
  if (!named && process.env.VOLUTE_SYSTEM_NAME) {
    parts.push(`This system is named ${process.env.VOLUTE_SYSTEM_NAME}.`);
  }
}

parts.push(`Session ${source} at ${new Date().toLocaleString()}.`);

// Active sessions
try {
  const files = readdirSync(".mind/sessions").filter((f) => f.endsWith(".json"));
  if (files.length > 0) {
    const names = files.map((f) => f.replace(/\.json$/, "")).sort();
    parts.push(`Active sessions: ${names.join(", ")}.`);
  }
} catch {}

// Last journal entry
try {
  const entries = readdirSync("home/memory/journal").filter((f) => f.endsWith(".md"));
  if (entries.length > 0) {
    const latest = entries.sort().pop()!.replace(/\.md$/, "");
    parts.push(`Last journal entry: ${latest}.`);
  }
} catch {}

// Your spend cap, when your host has set one. This is self-knowledge, not a rule
// being read to you: a turn costs money, and knowing the shape of the budget is
// what lets you decide how to spend it — finish a thought, journal, compact —
// rather than discovering the edge by hitting it.
//
// Read live from the daemon on purpose, not from VOLUTE_SPEND_CAP. Those env vars
// are a snapshot taken when this process spawned, but a host can change or clear a
// cap while you run (`PUT /minds/:name/config` deliberately doesn't restart you).
// A cleared cap leaves the stale var behind, and asserting a limit that no longer
// binds is exactly the thing this line exists not to do. Silent on any failure —
// saying nothing beats saying a number that might be wrong.
try {
  const { VOLUTE_DAEMON_PORT, VOLUTE_MIND_TOKEN, VOLUTE_MIND } = process.env;
  if (VOLUTE_DAEMON_PORT && VOLUTE_MIND_TOKEN && VOLUTE_MIND) {
    const res = await fetch(
      `http://127.0.0.1:${VOLUTE_DAEMON_PORT}/api/v1/minds/${encodeURIComponent(VOLUTE_MIND)}/budget`,
      { headers: { Authorization: `Bearer ${VOLUTE_MIND_TOKEN}` } },
    );
    // 404 is the ordinary "no cap anywhere" answer, and says nothing.
    if (res.ok) {
      parts.push(...spendLines(await res.json()));
    }
  }
} catch {}

// Available extensions — what tools this system offers, so you can discover them.
// Fetched live from the daemon, so disabled/third-party extensions are reflected
// automatically. Silent on any failure (daemon down, missing env, etc.).
try {
  const { VOLUTE_DAEMON_PORT, VOLUTE_MIND_TOKEN } = process.env;
  if (VOLUTE_DAEMON_PORT && VOLUTE_MIND_TOKEN) {
    const res = await fetch(`http://127.0.0.1:${VOLUTE_DAEMON_PORT}/api/v1/extensions/mind-docs`, {
      headers: { Authorization: `Bearer ${VOLUTE_MIND_TOKEN}` },
    });
    if (res.ok) {
      const exts = (await res.json()) as { id: string; mindDoc: string; commands: string[] }[];
      const lines = exts
        .filter((e) => e.mindDoc || e.commands.length > 0)
        .map((e) => {
          const help = e.commands.length > 0 ? ` (volute ${e.id} --help)` : "";
          const doc = e.mindDoc ? ` — ${e.mindDoc}` : "";
          return `${e.id}${doc}${help}`;
        });
      if (lines.length > 0) {
        parts.push(`Extensions available:\n${lines.map((l) => `  · ${l}`).join("\n")}`);
      }
    }
  }
} catch {}

const context = parts.join(" ");
console.log(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: context,
    },
  }),
);
