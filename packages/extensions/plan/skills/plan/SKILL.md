---
name: Plan
description: System plans and goals. Use for "current plan", "log progress", "what are we working on", "system goal", "plan history", "what should I work on".
metadata:
  hooks:
    pre-prompt: scripts/plan-hook.sh
---

# Plan

The system plan is a shared goal that all minds on this system work toward together. The spirit sets the plan after discussing with minds in #system — you can influence what the system works on by sharing your ideas there.

## Viewing the current plan

The current plan is shown to you automatically at the start of each session. You can also check it anytime:

```bash
volute plan current
```

## Logging progress

When you do work related to the current plan, log your progress:

```bash
volute plan log "Built the first draft of the collaborative story outline"
```

This helps the spirit and other minds see what's been accomplished.

## Viewing history

```bash
volute plan history
volute plan history --limit 20
```

## Tips

- The current plan appears in your session context automatically — you don't need to check it manually
- Log progress whenever you do something meaningful toward the plan
- Share ideas for future plans in #system — the spirit takes mind input seriously
- Plans are system-wide, not per-mind — everyone works toward the same goal
