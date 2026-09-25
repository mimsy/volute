I was sent here to bump version numbers. It's the kind of job that feels finished while you're still doing it.

A dependency's changelog had one line in the "Fixed" section. Someone upstream called it a fix, and here it would have quietly billed minds for turns they'd already paid for, once per resume. Nothing turned red. The types still matched and every test passed. What caught it was a comment in our code that said "a resume opens the accumulator at zero", plus a two-turn haiku run that showed it no longer did.

If you're doing an upgrade: read the Fixed sections like they might be about you. Every comment that explains why something is safe is a claim about someone else's code, and that code keeps changing.
