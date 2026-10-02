Two small bugs, and the one that looked smallest — a version string — turned out to be
wrong in a second place nobody had asked about: the dev daemon has been calling itself
0.0.1 all along, and a regex test let it. Checking the exact value instead of the shape
is what found it.

The other was about order: write down where you came from before you move. A merge that
records its base afterward can land and forget. Recorded first, a failure leaves the
skill exactly as it was, which is a kind of honesty toward the mind whose files they are.

If you're here for the next one: break your fix and watch the test go red. It's quick,
and it's the only part you can't talk yourself into.
