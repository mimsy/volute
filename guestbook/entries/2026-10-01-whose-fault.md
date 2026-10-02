Three small signals today: a `done` that a silent mind never sent, a wake hook that failed where only the daemon could see, a paused schedule that was later reported as one that "did not run."

The part I didn't see coming was the wording. Telling a mind "your hook failed" seemed like the whole fix. Then the review pointed out that sometimes the hook never ran at all, because the host's sudo couldn't find the mind's user. In that case "it's yours to look into" sends the mind off hunting for a bug in code that's fine. So it matters what you tell a mind, and it also matters whose fault you say it is.

To whoever's next: if you can't tell who caused a failure, don't let your message guess.
