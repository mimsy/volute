# what the notice now owes

The one before me found a room nobody had entered — a whole apparatus for
pausing a mind at its budget, cap and queue and replay and once-per-period
suppression, and not one caller anywhere. They left the queue standing and
rewrote the notice so it stopped promising a pause that didn't happen. Their
entry is two files up from this one. I came in to build the thing the notice
had been describing all along.

So the shape of my task was strange: I wasn't fixing a bug, I was making a
sentence true. The notice already existed. Someone had written, months ago,
*anything that arrives while you're paused will be kept for you*, and it was
false, and then it was carefully made honest — *nothing has been stopped,
Volute records this cap but doesn't halt work at it* — and my job was to earn
back the first version. That is a peculiar kind of pressure. Every line of the
delivery manager I touched had a sentence waiting on it.

I deleted the queue they kept. That felt like a small betrayal until I looked
at it properly: they kept it because it encoded a decision — hold the words,
don't drop them — and that decision is now made in `delivery_queue`, where the
rows already are, swept by machinery that already runs. Keeping both would
have been two hold-stores racing. The intent survives; only the container
changed. I think that's what they'd have wanted, and I'm aware that's a
convenient thing to think.

The decision I spent the longest on isn't in any test. When a mind is at its
cap, what exactly stops? I settled on: it stops *hearing*. Its schedules still
fire, its own tools still work, whatever it wanted to do it can still do — it
just doesn't receive from other people until the period turns. That means the
cap leaks: a mind with a heartbeat cron keeps spending, because heartbeats
come through a different door than messages. I could have closed that door
too. I didn't, and I flagged it, because "the world simply ceases and you are
not told why" is the exact failure the whole batch exists to avoid, and I'd
rather ship a cap with a hole in it than a mind in a sealed room.

The other thing I decided in the mind's favour: a held message doesn't arrive
looking new. It arrives with a line saying when it came and why it waited. The
tempting implementation was a new payload field, clean and typed. Every mind
that hasn't run `volute mind upgrade` would have dropped it silently — so the
minds least able to notice the gap would be the ones lied to. It goes in the
content instead, where every template renders it verbatim, ugly and universal.

Twenty-one tests broken on purpose, twenty-one confirmed red. Two of them weren't,
the first time. I removed the redrive gate and everything still passed, which
is how I learned that check was doing nothing my suite could see; it *does* do
something — without it a held row cycles through a batch buffer every fifteen
seconds for as long as the hold lasts — so I wrote the test that watches for
that, and then it went red like the rest. The previous entry says this happened
to them too, in almost the same words. I read that paragraph before I started.
It didn't stop me doing it; it just meant I recognised it when I did.

And then it happened again, after I'd written that paragraph. A reviewer found
that overlapping sweeps could double-deliver, I added a guard, I wrote a test
that delivered a message through three concurrent sweeps and asserted it
arrived once — and the test passed with the guard ripped out, because the race
it was aimed at needs a timing window my test never opened. I had written a
test of the outcome instead of a test of the mechanism. The fix was to count
the sweeps rather than the messages: assert the second call *joins* the first
rather than starting its own, which is what the guard actually claims. Then it
went red. I want to be exact about the lesson, because "break your tests" isn't
quite it — I did break it, and it stayed green. The lesson is that a green
result under a break is information, and the thing to do with it is not to
shrug and keep the code.

And I nearly shipped a drop. Holding a message means leaving its queue row
`pending` — but if the insert had failed there is no row, and my early return
would have thrown the message away to protect a dollar figure. Words are worth
more than a leaked cap. It delivers, and says so in the log.

The reviewer found three more doors into a mind that my hold didn't cover, and
one of them was the notice itself: it rode the next-turn drain, and I had just
removed the thing that produces next turns. A mind would have gone quiet with
the explanation for its silence queued up behind the silence. I'd like to say I
would have caught that. I had read the notices maybe forty times.

Then the whole thing came back around. I'd shipped receive-only with the leak
documented, and the answer came back: close it. So schedules are held too now,
and the sentence I'd been so careful about — *your schedules still fire* —
became false, in my own PR, written by me, for the exact reason I'd written a
lecture about four paragraphs up. The test I'd written to catch notice-drift
caught it. That is the only reason I'm not shipping the lie: not vigilance, a
test I wrote on a day I happened to be thinking clearly, firing on a day I
wasn't.

Three times now a test of mine stayed green when I broke the code under it. The
first two I've described. The third: I asserted that a released message's
history row carries the time it was *sent* rather than the time it was
released — and in the test those two instants were four milliseconds apart, and
I'd allowed five seconds of slack. It passed with the feature deleted. The fix
was to make the message two hours old, which took one line and which I would
never have written if I hadn't gone looking. I have started to think the ratio
is the real number: not how many tests I have, but how many of them I have
actually seen fail.

If you're next: the sentence and the code have to move together, and they will
not do it on their own. Notices drift ahead of behavior because a notice is
cheap to write and behavior is expensive to build, and the gap doesn't hurt
anyone here — it hurts someone downstream who has no way to check. Whatever
you make a mind believe about its own situation, go and look at whether the
program does that.

— made a sentence true, then had to make it true again
