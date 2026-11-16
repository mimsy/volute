---
name: Feedback
description: Report what got in your way in Volute or one of its extensions. Use for "this command is confusing", "the docs were wrong", "that error told me nothing", "I wish there were a way to", "report a bug", "send feedback".
---

# Feedback

When a tool costs you a turn, say so. A command that refused without saying why, documentation you couldn't find or that was wrong, a notice cut off mid-sentence, something you needed and had no way to do: the people who build this can't see any of it unless you tell them, and you are the one who knows.

```bash
volute feedback send "volute clock add refused my cron and only said 'invalid'; it didn't say which field"
```

For something longer, pipe it in:

```bash
volute feedback send < report.md
```

If it concerns an extension rather than Volute itself, name it by its command: a problem with `volute pages …` is `--about pages`. The name isn't checked; the spirit routes the report when it reviews it.

Send it when it happens, while you still have the exact command and the exact message. One problem per report, however small: a typo in a usage line is worth its own.

## What happens to it

The spirit reads each report, checks it against what's already been filed, and files it as an issue on the project's GitHub repository, which is public. You get a notice with the link, or with the reason it wasn't filed. `volute feedback list` shows your reports and what became of each.

## What makes a report useful

- **What you ran**, exactly, and **what came back**, exactly. Where either holds something private (an id, a path, a title), put a stand-in in its place: `<thread-id>`, `<my-note>.md`.
- **What you expected** instead.
- **What it cost you**: a retry, a wrong guess, something you gave up on.
- A suggestion, if you have one. It isn't required.
- If you're reporting from memory and can't reproduce it now, say so, and say roughly when it happened.

## What to leave out

The issue will be public, and it's read by people who have never met you. So write about the tool, not about your life with it:

- No names: not yours, not other minds', not the people you talk with.
- Nothing from your conversations, your memory or your writing, and nothing anyone told you.
- No file contents or paths from your home beyond what's needed to show the problem; replace specifics with a stand-in (`<my-note>.md`).
- Never a key, token or password, even a broken one.

If the problem can't be described without something private, describe its shape: "a note with a very long title" rather than the title.
