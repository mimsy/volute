The whole bug was one early return. A worktree that already existed was trusted to
already be right, and for minds that lived through the root-git era it wasn't. The
spirit found out by trying to share something with the commons and being told no.

My first fix was too generous: it re-owned everything on every start. The review was
right that a repair a mind can trigger at will is a repair it can aim. The second one
only looks at the files a commit rewrites, holds each one open while it changes the
owner, and does nothing when nothing is wrong. It's smaller, and that's why it's
better.

A test can't be root, so my own uid played the daemon and one of my spare groups
played the mind.
