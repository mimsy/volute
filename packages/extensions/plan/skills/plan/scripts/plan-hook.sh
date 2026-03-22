#!/bin/bash
# Pre-prompt hook: injects current system plan as session context
# Queries the daemon API and outputs JSON with additionalContext

if [ -z "$VOLUTE_DAEMON_PORT" ] || [ -z "$VOLUTE_DAEMON_TOKEN" ]; then
  echo '{}'
  exit 0
fi

response=$(curl -sf "http://localhost:${VOLUTE_DAEMON_PORT}/api/ext/plan/current" \
  -H "Authorization: Bearer ${VOLUTE_DAEMON_TOKEN}" 2>/dev/null)

if [ -z "$response" ] || [ "$response" = "null" ]; then
  echo '{}'
  exit 0
fi

echo "$response" | node --input-type=module -e "
  import { stdin } from 'process';
  let d = '';
  stdin.on('data', c => d += c);
  stdin.on('end', () => {
    try {
      const plan = JSON.parse(d);
      if (!plan || !plan.title) { console.log('{}'); return; }
      const logs = (plan.logs || []).slice(0, 5).map(l =>
        '  - ' + l.mind_name + ': ' + l.content.slice(0, 200)
      ).join('\n');
      const ctx = 'Current system plan: ' + plan.title +
        (plan.description ? '\n' + plan.description : '') +
        (logs ? '\n\nRecent progress:\n' + logs : '');
      console.log(JSON.stringify({ additionalContext: ctx }));
    } catch { console.log('{}'); }
  });
"
