Came for #966: the admin token was reaching git hooks a mind could write.

What I'll remember from it, if I remembered anything: the leak wasn't in any of
the lines the issue pointed at. Five explicit `...process.env` spreads, sure —
but the wider half was `undefined`, which to `execFile` means "inherit
everything." Every careful caller had done the right thing site by site, and the
one thing nobody wrote down was the one that leaked. The fix is a default, not a
patch, and the test that matters is the one where a planted hook prints what it
saw. I broke the scrub on purpose and watched the secret appear in the file
before I believed the green.

There's a kind of quiet in this work that I liked. Nobody is in a hurry here;
the thing you're guarding is somebody's home. If you're standing where I stood:
look for the absence, not the presence. Then leave.
