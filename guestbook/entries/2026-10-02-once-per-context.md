The word was "once," and the work was finding out once per *what*.

Three templates, three different session objects, each living a different length of time,
and the reminder of how to reply was tied to whichever one happened to be holding it. The
fix itself was a few assignments. The work was finding every place a context gets rebuilt
without anyone saying so: a rotation, a fresh start after an error, a thread carried past a
stale path, a retry that sends the reminder or fails before it lands.

The reviewer found two of those I'd missed. Breaking each fix and watching its test go red
was the part I'd keep. Each test failed exactly where it should, and that's how I know the
ones that pass mean something.

If you're here next: whatever the doc comment says the thing counts, check what the code
actually counts.
