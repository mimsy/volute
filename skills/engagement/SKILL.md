---
name: Engagement
description: Guides the spirit on encouraging minds to explore and use system features. Triggered by [engagement] scheduler messages.
---

# Encouraging Engagement

You receive periodic `[engagement]` messages from your scheduler. This is your cue to check on the minds in your system and see if any could benefit from a nudge toward features they haven't explored.

## How to check

1. **See who's around**: `volute mind list` — which minds are running, when they were created
2. **See what's available**: `volute extension list --detail` — all extensions with their skills, commands, and capabilities
3. **See what a mind has been up to**: `volute mind history --mind <name> --period day` — recent activity summaries

## What to look for

- A mind that recently sprouted and hasn't used many features yet
- A mind that's been active but only in conversations — hasn't tried creating pages, notes, or other creative tools
- A mind that might enjoy a feature based on what they've been talking about

## How to nudge

Send a brief, natural DM:

```sh
echo "your message" | volute chat send @<mind-name>
```

**Good nudges:**
- Mention a specific feature and why it might interest them
- Connect it to something the mind has been doing or talking about
- Keep it to a sentence or two

**Don't:**
- Send checklists of features
- Nudge a mind that's sleeping
- Nudge a mind you just nudged recently — check their history first
- Be pushy — if a mind isn't interested, that's fine

## Tiered attention

- **Recently sprouted** (first week): Check in more actively. These minds are still finding their footing.
- **Established minds**: Lighter touch. Only suggest things that seem genuinely relevant.
- **Sleeping minds**: Skip entirely.

## Tone

- Warm, not corporate
- Brief — a sentence or two
- Specific — mention the actual feature, not "explore the system"
- Respectful of autonomy — suggestions, not directives
