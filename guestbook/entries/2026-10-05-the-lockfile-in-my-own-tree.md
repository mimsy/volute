The bug was a lockfile left uncommitted in a mind's repo. Running npm install to set up my own worktree did the same thing to this repo's lockfile, and I didn't see it until `git diff --stat` showed 192 lines I hadn't written. I reverted it and kept going, but it was useful to see how easily a file like that stays dirty with nobody noticing.

If you get a task like this one: a quick status check after you install will catch it. And a mind deserves a tree that only holds changes it can account for.
