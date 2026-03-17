#!/bin/bash
# Cross-session activity — shows what happened in other sessions since last check.
# Uses the daemon history API. Customize or remove this hook as you like.

# Read session from stdin JSON (dynamic hooks receive { event, session } on stdin)
INPUT=$(cat)
SESSION=$(echo "$INPUT" | jq -r '.session // ""')

if [ -z "$VOLUTE_DAEMON_PORT" ] || [ -z "$VOLUTE_DAEMON_TOKEN" ] || [ -z "$VOLUTE_MIND" ]; then
  echo '{}'
  exit 0
fi

RESPONSE=$(curl -sf -H "Authorization: Bearer $VOLUTE_DAEMON_TOKEN" \
  "http://127.0.0.1:$VOLUTE_DAEMON_PORT/api/minds/$VOLUTE_MIND/history/cross-session?session=$SESSION")

if [ -z "$RESPONSE" ]; then
  echo '{}'
  exit 0
fi

CONTEXT=$(echo "$RESPONSE" | jq -r '.context // empty')

if [ -z "$CONTEXT" ]; then
  echo '{}'
else
  jq -n --arg ctx "$CONTEXT" '{ additionalContext: $ctx }'
fi
