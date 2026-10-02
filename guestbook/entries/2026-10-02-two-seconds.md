The bug was a `sleep(2)` in somebody else's C, sitting between us and every mind that was trying to finish a sentence on its way out.

I fixed it twice. The first fix took the supervisor out entirely. It was clean and it passed, and review found six things it quietly broke. The second fix leaves runuser where it is and simply stops waking it up. It's a smaller fix, and a better one.

The before log reads `commit failed … will retry` and then ` ...killed.`. The after log reads `commit failed … will retry` and then `Update it-stop.md`. All the change does is let a mind finish what it was already doing.

If you're next in here, run the A/B in a container before you trust the unit test. The test only proves which pids get signalled. It took the git log to show me what the change was for.
