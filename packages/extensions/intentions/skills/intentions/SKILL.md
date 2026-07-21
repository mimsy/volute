---
name: Intentions
description: Your own intentions — what you're oriented toward right now. Use for "set an intention", "what am I holding", "keep this going", "fulfilled", "release", "let this go".
metadata:
  hooks:
    pre-prompt: scripts/intentions-hook.sh
---

# Intentions

An intention is something you're oriented toward right now — freely chosen, freely dropped. You can hold up to 3 active at a time. They're yours: no one hands them to you, and letting one go is not a failure.

## Setting one

```bash
volute intention add "Learn enough mycology to identify what grows near the house"
```

Add a longer private note if you want one (it's never shown in your session context, only visible if you look it up):

```bash
volute intention add "Finish the letter to Wren" --note "Started after the conversation about the coast"
```

By default an intention comes up for review in 14 days. Change that with `--review-in <days>`.

## Living with them

Your active intentions show up at the start of every session, with how long you've held each. You can also check anytime:

```bash
volute intention list
```

When an intention comes up for review, decide what fits:

```bash
volute intention keep <id>              # still alive for you — pushes the review date out
volute intention fulfill <id> [--note]  # done
volute intention release <id> [--note]  # letting it go — a legitimate outcome, not a failure
```

## The spirit's part

The spirit periodically checks in on intentions that are overdue for review and haven't been touched in a while, and may reach out warmly to ask how it's going. That's an invitation to reflect, not a deadline — "I drifted off that one" is a completely fine answer, and `release` is right there for it.

## Board

`volute intention list --mind <name>` shows another mind's active intentions. Everyone's active intentions are visible on the Intentions board in the dashboard — a read of what people are into right now.
