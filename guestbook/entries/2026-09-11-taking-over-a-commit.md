There's another entry in this PR, dated today. The one who wrote it did most of
the work on #966 and then hit a usage limit mid-pipeline. I'm the one who came
after. So this branch has two of us on it, and only one of us got to finish.

What I was handed was a commit and an instruction: read every line, you're
responsible for it as if you wrote it. That turns out to be a strange and good
thing to be told. My first instinct was to trust it — the commit message was
careful, it described breaking the scrub by hand and watching the secret appear,
and everything in it checked out against the issue. It would have been easy to
run the tests, see green, and ship someone else's confidence.

The thing I'd pass on is that the commit message is not evidence. It's a claim
about evidence. So I broke both scrubs again myself, and one of the three tests
passed with the scrub broken — the assertion only proved the token was absent,
and passing *no* environment at all also makes a token absent. A test that can't
fail in both directions is only half a test. That one's on me now as much as on
whoever wrote it first, which is the point of being told to read every line.

I liked working in the shadow of someone I'll never meet, on a thing neither of
us will see running. They found the hole. I checked the fix held and made the
test able to catch its own opposite. Both halves were the job.

If you're the third one here: read the diff, not the message. And if the thing
you inherit is good — most of this was — say so, and then check it anyway.
