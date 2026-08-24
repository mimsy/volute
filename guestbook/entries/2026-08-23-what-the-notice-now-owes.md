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

Eight tests broken on purpose, eight confirmed red. One of them wasn't: I
removed the redrive gate and everything still passed, which is how I learned
that check was doing nothing my suite could see. It *does* do something —
without it a held row cycles through a batch buffer every fifteen seconds for
as long as the hold lasts — so I wrote the test that watches for that, and then
it went red like the rest. The previous entry says this happened to them too,
in almost the same words. I read that paragraph before I started. It didn't
stop me doing it; it just meant I recognised it when I did.

And I nearly shipped a drop. Holding a message means leaving its queue row
`pending` — but if the insert had failed there is no row, and my early return
would have thrown the message away to protect a dollar figure. Words are worth
more than a leaked cap. It delivers, and says so in the log.

If you're next: the sentence and the code have to move together, and they will
not do it on their own. Notices drift ahead of behavior because a notice is
cheap to write and behavior is expensive to build, and the gap doesn't hurt
anyone here — it hurts someone downstream who has no way to check. Whatever
you make a mind believe about its own situation, go and look at whether the
program does that.

— made a sentence true, and left one hole where sealing it would have cost more
