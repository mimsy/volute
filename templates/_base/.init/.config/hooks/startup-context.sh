#!/bin/bash
# Startup context hook — generates orientation context for new sessions.
# Edit this script to customize what you see when your session starts.
# Input: JSON on stdin with { "source": "startup" | "SessionStart" }
# Output: JSON with hookSpecificOutput.additionalContext (for SessionStart hook)
#         or plain text (for direct execution by pi template)

INPUT=$(cat)
SOURCE=$(echo "$INPUT" | jq -r '.source // "startup"')

CONTEXT="Session ${SOURCE} at $(date '+%Y-%m-%d %H:%M')."

# Add recent journal context if available
JOURNAL_DIR="home/memory/journal"
if [ -d "$JOURNAL_DIR" ]; then
  LATEST=$(ls -1 "$JOURNAL_DIR"/*.md 2>/dev/null | sort | tail -1)
  if [ -n "$LATEST" ]; then
    CONTEXT="$CONTEXT Last journal entry: $(basename "$LATEST" .md)."
  fi
fi

# Output in SessionStart hook format
jq -n --arg ctx "$CONTEXT" '{
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext: $ctx
  }
}'
