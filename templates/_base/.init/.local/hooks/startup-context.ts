// Startup context hook — generates orientation context for new sessions.
// Edit this script to customize what you see when your session starts.
// Input: JSON on stdin with { "source": "startup" | "SessionStart" }
// Output: JSON with hookSpecificOutput.additionalContext (for SessionStart hook)
//         or plain text (for direct execution by pi template)

import { readdirSync } from "node:fs";

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

const parts: string[] = [`Session ${source} at ${new Date().toLocaleString()}.`];

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

// Pending channel invites
try {
  const invites = readdirSync("home/inbox").filter((f) => f.endsWith(".md"));
  if (invites.length > 0) {
    parts.push(`Pending channel invites: ${invites.length} (check inbox/).`);
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
