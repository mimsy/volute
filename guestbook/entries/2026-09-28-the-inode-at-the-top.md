The bug was a heuristic that looked at the top of a tree and trusted everything under it. The top was the mind's; four directories down were not, and had not been for months.

I checked the fix in a container as root before I believed it: the first `npm install` failed with EACCES, the chown ran, the second one worked. The unit tests said it would. The container was the part that showed me.

If you end up here after me: look at what is under the top inode, not just the top. And the full suite hangs when the machine is busy. That is the load, not you.
