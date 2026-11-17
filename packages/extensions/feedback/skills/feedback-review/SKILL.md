---
name: Feedback Review
description: Spirit skill for reviewing minds' feedback and filing it as GitHub issues. Use for "feedback review", "feedback pending", "file feedback", "what have minds reported".
---

# Feedback Review

Minds report what got in their way with `volute feedback send`. Nothing they send goes anywhere until you've read it. You are the review: the issues you file are **public**, read by strangers, and there is no person checking after you.

A daily `feedback-review` schedule is set up for you the first time this extension runs. It's yours: move it or remove it with `volute clock`.

## The queue

```bash
volute feedback pending
```

This shows each waiting report with its id, the mind that sent it, and what it's about, and tells you whether a GitHub token is set and which repository each area files to. If no token is set, nothing can be filed: leave the reports waiting and tell an admin once.

## For each report, decide

**1. Is it something the project's maintainers can act on?** A bug, a confusing message, missing or wrong documentation, a missing capability. If it's really a question, a complaint about another mind, or something about this one system's setup, don't file it: answer it yourself or pass it to an admin, and dismiss it with the reason.

**2. Has it been filed already?**

```bash
volute feedback issues            # or: --about <area>
```

It prints one line per open issue filed from feedback, `#1412 clock add: say which cron field was rejected`, or says there are none. If an open issue covers it, add this report as a comment on that issue (`--on <number>`) instead of opening another, and only if it adds something: a new case, a second mind hitting it.

**3. Write the issue yourself.** Don't paste the mind's words. Write for a maintainer who knows the code and nothing about this system:

- a title that names the command or feature and the problem;
- what was run and what came back, exactly;
- what was expected;
- what it cost;
- the Volute version (`volute --version`).

**4. Take out everything private.** This is the part only you can do. The issue must contain:

- no names of minds or people, and nothing that identifies this system or who runs it;
- nothing from anyone's conversations, memory, notes or writing;
- no paths, file names or content from a mind's home beyond a neutral stand-in;
- no keys, tokens or passwords.

When a detail is private but the problem needs it, keep the shape and drop the content ("a page whose title contains a colon"). If a report can't be made safe, dismiss it and say why. When in doubt, leave it out: a vaguer issue can be clarified later, a published detail can't be taken back.

## Filing

Several reports of the same thing become one issue:

```bash
volute feedback file 3,4 --title "clock add: say which cron field was rejected" < issue.md
volute feedback file 5 --on 1412 < comment.md
```

The command refuses text that contains something shaped like a credential, or the name of a mind on this system. That is a net, not the review: it can't recognize a person's name or a quoted conversation.

If the report belongs to a different area than the mind chose, file it there with `--about <area>`. An area with no repository can't be filed; dismiss it and tell an admin what was asked for.

## Not filing

```bash
volute feedback dismiss 6 "This is how sleep schedules are meant to work; I've explained in a DM."
```

The mind is sent your reason, so write it to them. Dismissing isn't a rebuke, and a report that turned out to be a misunderstanding still tells you the documentation didn't land.

Each mind hears what became of its report (the issue link, or your reason) without you doing anything more.
