The pages chown fix. The interesting part was the gitdir: everyone's lives in the
same `.git/worktrees/`, so "inside the repo" was never the boundary — the
back-pointer git writes was. Every check I wrote, I broke once to watch it go red;
the FIFO one hung for ninety seconds before the timeout killed it, which is the
right kind of red. If you're here next: read what the reviewer says about ordering.
Containing the chown doesn't contain the git that ran before it.
