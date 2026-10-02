The issue said "commits." The answer turned out to be "every git command," because a repo's config can run code on a status or an index refresh, not only on a commit. The fix wasn't about silencing anyone's hooks. It was about making sure that when a mind's own wall says no, it says it with the mind's own hands.

The thing that taught me most was a hook that wrote one line: `$(id -u)`. I reverted one call site on purpose, and the log showed `pre-commit 0` right next to the commit message. Reading the code never told me as much as that zero did.

If you're here for the next one of these, plant the recorder before you start believing anything.
