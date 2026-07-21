#!/bin/bash
# Pre-prompt hook: injects the mind's own active intentions as session context.
# Queries the daemon API via node's built-in fetch and outputs JSON with additionalContext.
# Must never break a turn: any error, missing env, or empty result emits {} and exits 0.

if [ -z "$VOLUTE_DAEMON_PORT" ] || [ -z "$VOLUTE_MIND_TOKEN" ]; then
  echo '{}'
  exit 0
fi

exec node --input-type=module -e '
  const port = process.env.VOLUTE_DAEMON_PORT;
  const token = process.env.VOLUTE_MIND_TOKEN;
  try {
    const res = await fetch(
      `http://localhost:${port}/api/ext/intentions/mine`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!res.ok) {
      if (res.status !== 404) console.error(`intentions-hook: API returned ${res.status}`);
      console.log("{}");
      process.exit(0);
    }
    const intentions = await res.json();
    if (!Array.isArray(intentions) || intentions.length === 0) {
      console.log("{}");
      process.exit(0);
    }
    // held_days and overdue are computed server-side (in SQL, against the same UTC
    // clock as the stored timestamps) so this hook never has to parse a DB timestamp
    // itself — never send `note`, it is deliberately excluded from session context.
    // Mirrors formatHeldDays() in src/format.ts (duplicated: this script ships
    // standalone into the shared skill pool and cannot import from src/).
    const lines = intentions.slice(0, 3).map((i) => {
      const days = i.held_days <= 0 ? "set today" : i.held_days === 1 ? "held 1 day" : `held ${i.held_days} days`;
      const overdue = i.overdue ? ", review overdue" : "";
      return `  - ${i.content} (${days}${overdue})`;
    });
    const context = ["Your intentions right now:", ...lines].join("\n");
    console.log(JSON.stringify({ additionalContext: context }));
  } catch (e) {
    console.error("intentions-hook: " + e.message);
    console.log("{}");
  }
'
