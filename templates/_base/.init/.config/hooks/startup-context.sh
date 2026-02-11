#!/bin/bash
# Startup context hook — generates orientation context for new sessions.
# Edit this script to customize what you see when your session starts.
# Input: JSON on stdin with { "source": "startup" | "SessionStart" }
# Output: JSON with hookSpecificOutput.additionalContext (for SessionStart hook)
#         or plain text (for direct execution by pi template)

INPUT=$(cat)
SOURCE=$(echo "$INPUT" | jq -r '.source // "startup"')

CONTEXT="Session ${SOURCE} at $(date '+%Y-%m-%d %H:%M')."

# Active sessions
SESSIONS_DIR=".volute/sessions"
if [ -d "$SESSIONS_DIR" ]; then
  SESSION_LIST=$(ls -1 "$SESSIONS_DIR"/*.json 2>/dev/null | xargs -I{} basename {} .json | sort)
  if [ -n "$SESSION_LIST" ]; then
    CONTEXT="$CONTEXT Active sessions: $(echo "$SESSION_LIST" | tr '\n' ', ' | sed 's/, $//')."
  fi
fi

# Last journal entry
JOURNAL_DIR="home/memory/journal"
if [ -d "$JOURNAL_DIR" ]; then
  LATEST=$(ls -1 "$JOURNAL_DIR"/*.md 2>/dev/null | sort | tail -1)
  if [ -n "$LATEST" ]; then
    CONTEXT="$CONTEXT Last journal entry: $(basename "$LATEST" .md)."
  fi
fi

# Pending channel invites
INBOX_DIR="home/inbox"
if [ -d "$INBOX_DIR" ]; then
  INVITE_COUNT=$(ls -1 "$INBOX_DIR"/*.md 2>/dev/null | wc -l | tr -d ' ')
  if [ "$INVITE_COUNT" -gt 0 ] 2>/dev/null; then
    CONTEXT="$CONTEXT Pending channel invites: ${INVITE_COUNT} (check inbox/)."
  fi
fi

# Output in SessionStart hook format
jq -n --arg ctx "$CONTEXT" '{
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext: $ctx
  }
}'
