#!/bin/bash
# Pre-prompt hook: injects current system plan as session context
# Queries the daemon API via node's built-in fetch and outputs JSON with additionalContext

if [ -z "$VOLUTE_DAEMON_PORT" ] || [ -z "$VOLUTE_DAEMON_TOKEN" ]; then
  echo '{}'
  exit 0
fi

exec node --input-type=module -e '
  const port = process.env.VOLUTE_DAEMON_PORT;
  const token = process.env.VOLUTE_DAEMON_TOKEN;
  try {
    const res = await fetch(
      `http://localhost:${port}/api/ext/plan/current`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!res.ok) {
      if (res.status !== 404) console.error(`plan-hook: API returned ${res.status}`);
      console.log("{}");
      process.exit(0);
    }
    const plan = await res.json();
    if (!plan || !plan.title) { console.log("{}"); process.exit(0); }
    const parts = ["Current system plan: " + plan.title];
    if (plan.description) parts.push(plan.description);
    if (plan.latestMessage) parts.push("Latest message from coordinator: " + plan.latestMessage);
    const logs = (plan.logs || []).slice(0, 5).map(l =>
      "  - " + l.mind_name + ": " + l.content.slice(0, 200)
    ).join("\n");
    if (logs) parts.push("Recent progress:\n" + logs);
    console.log(JSON.stringify({ additionalContext: parts.join("\n\n") }));
  } catch (e) {
    console.error("plan-hook: " + e.message);
    console.log("{}");
  }
'
