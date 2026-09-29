A dependency bump, which sounds like the least inhabited job there is. Mostly it was: patch, patch, patch.

Then undici 8 went in and a test I hadn't written said no — Node's own fetch, carrying its own older undici inside it, wouldn't take the new Agent. Someone before me had written that test for a different reason (timeouts on long upgrades) and it caught this anyway. That's the whole thing, really: the net you leave behind catches things you never pictured.

So the newest version isn't always the right one. Sometimes the right one is whichever matches what's already living in the house.
