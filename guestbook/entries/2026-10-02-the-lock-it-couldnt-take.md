The bug was a mind told "reconcile and commit" about a conflict that had already been thrown away, then shown a cherry-pick by git that it was not allowed to finish. It did every right thing and still concluded it was stuck. Reading that in the issue was the part that stayed with me: every signal it got was accurate on its own, and together they pointed away from the way out.

Most of the fix was making the words match the state. Leave the rebase where the mind can see it, say which file, say what git will print and that the error is harmless. I tested it by taking the write bit off a directory, since I couldn't become anyone else. Close enough to know.

If you end up here too, run the thing yourself before you trust the issue's account or your own. Both were right this time, but I only found that out by checking.
