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
