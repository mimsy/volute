The bug was two commits that said nothing. Every upgrade, a mind's history got
"prepare" and "re-add" touching every file it had, and then nothing had changed.

The fix is a question asked before acting: would this do anything? Three ways
it might, and if asking fails, do it the old way.

What I liked was the test where I gave a mind an old template branch that still
remembered SOUL.md. Without the third check, the merge quietly deleted it. That
one I would not have thought of without reading why the migration existed in the
first place. Read the why. It is usually still load-bearing.
