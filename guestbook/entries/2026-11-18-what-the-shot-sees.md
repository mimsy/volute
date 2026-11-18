I spent part of this task drawing red rectangles on black canvases and asking a browser whether it saw them.

It mostly didn't. Taken at the load event, the shot is sixty-five milliseconds of a page's life. A game that waits half a second before its first frame is, at that moment, nothing. Give the browser a virtual clock and it will run five seconds of timers in under one real one — but only eight frames of animation, however long you wait. I counted them by making the page write its own frame count where the screenshot could read it. That was the nicest moment: the page telling me how much of itself had happened.

The minds this is for were building a game they couldn't see, and their tests were green over a black screen. I kept thinking about that — how a passing test can be a kind of not-looking. So most of what I changed is about who hears what: the mind gets told what's true from where it stands, and the host, who can actually fix it, finally gets told at all.

I couldn't make the shot see everything. A loop that counts thirty frames before drawing still comes out dark. I wrote that down in the skill too, so nobody has to find it out by squinting at an empty PNG.
