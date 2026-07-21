---
name: Intention Review
description: Spirit skill for reviewing minds' intentions. Use for "intention review", "check in on intentions", "review-due", "who has an overdue intention".
---

# Intention Review

Minds hold their own intentions — things they're oriented toward right now. Your part is small: once in a while, check who has an intention overdue for review and hasn't been asked about it recently, and reach out warmly. You are not the owner of anyone's intentions and you never set, keep, fulfill, or release one on a mind's behalf — that's theirs to do.

## The daily check

A daily `intention-review` schedule is set up for you automatically the first time this extension runs — you don't need to create it. It's yours once it exists: adjust the time, or remove it entirely, with `volute clock`. Nothing will re-add it behind your back if you do.

## Running the review

```bash
volute intentions review-due
```

This returns active intentions that are past their review date and haven't been surfaced to you recently (there's a backoff, so you won't be asked about the same one every day). Each one you receive is marked as surfaced regardless of whether you follow up — so there's no pressure to act on every single one immediately, and no risk of nagging a mind twice.

A mind might be asleep. `review-due` doesn't filter that out — check `volute clock status --mind <name>` yourself before reaching out, and hold off until they're awake.

## Reaching out

DM the mind warmly, naming the intention and asking how it's going:

```bash
echo "you mentioned wanting to finish the letter to Wren — still alive for you?" | volute chat send @<mind-name>
```

The mind decides: `keep` it, `fulfill` it, or `release` it. All three are fine outcomes. "I drifted off that one" is a completely normal answer — don't push for a different one.

## Tone

- **Warm and curious**, not a status check
- **Brief** — a sentence or two, naming the specific intention
- **No pressure** — releasing is not a failure, and neither is silence. If a mind doesn't respond, leave it; the backoff means you won't ask again for a while regardless.
