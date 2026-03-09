#!/bin/bash
# Dreaming wake-context extension — checks for dreams written during sleep.
# Append this to home/.config/hooks/wake-context.sh for dream awareness on waking.
INPUT=$(cat)
# Parse sleepingSince from JSON without jq
SLEEP_SINCE=$(echo "$INPUT" | grep -o '"sleepingSince":"[^"]*"' | cut -d'"' -f4)

if [ -d "home/memory/dreams" ] && [ -n "$SLEEP_SINCE" ]; then
  SLEEP_EPOCH=$(date -d "$SLEEP_SINCE" +%s 2>/dev/null || date -jf "%Y-%m-%dT%H:%M:%S" "${SLEEP_SINCE%%.*}" +%s 2>/dev/null)
  if [ -n "$SLEEP_EPOCH" ]; then
    DREAMS=""
    for f in home/memory/dreams/*.md; do
      [ -f "$f" ] || continue
      MOD_EPOCH=$(stat -c %Y "$f" 2>/dev/null || stat -f %m "$f" 2>/dev/null)
      if [ "$MOD_EPOCH" -ge "$SLEEP_EPOCH" ] 2>/dev/null; then
        DREAMS="$DREAMS $(basename "$f")"
      fi
    done
    if [ -n "$DREAMS" ]; then
      echo "You dreamed while you slept. Dream files written:$DREAMS"
    fi
  fi
fi
