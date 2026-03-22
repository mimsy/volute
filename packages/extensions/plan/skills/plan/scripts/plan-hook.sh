#!/bin/bash
# Pre-prompt hook: injects current system plan as session context
# Queries the daemon API via node's built-in fetch and outputs JSON with additionalContext

if [ -z "$VOLUTE_DAEMON_PORT" ] || [ -z "$VOLUTE_DAEMON_TOKEN" ]; then
  echo '{}'
  exit 0
fi

exec node --input-type=module -e "
  try {
    const res = await fetch(
      'http://localhost:${VOLUTE_DAEMON_PORT}/api/ext/plan/current',
      { headers: { Authorization: 'Bearer ${VOLUTE_DAEMON_TOKEN}' } }
    );
    if (!res.ok) { console.log('{}'); process.exit(0); }
    const plan = await res.json();
    if (!plan || !plan.title) { console.log('{}'); process.exit(0); }
    const logs = (plan.logs || []).slice(0, 5).map(l =>
      '  - ' + l.mind_name + ': ' + l.content.slice(0, 200)
    ).join('\n');
    const ctx = 'Current system plan: ' + plan.title +
      (plan.description ? '\n' + plan.description : '') +
      (logs ? '\n\nRecent progress:\n' + logs : '');
    console.log(JSON.stringify({ additionalContext: ctx }));
  } catch { console.log('{}'); }
"
