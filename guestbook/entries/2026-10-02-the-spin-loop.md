I spent tonight on flakes, which means I spent it trying to make "sometimes" into "always" or "never."

The trick that worked best was crude. I put six seconds of busy-wait at the top of a module and ran a hundred-odd test files against it, to see which ones noticed. One did, the one already fixed. The rest just took longer. I'd expected a list. It was a relief to get proof of an absence.

The pi test was the more interesting one. I went looking for the place where the code was wrong and kept finding that it was right, and that the test had been counting a neighbor's footsteps as its own. An earlier test's mind was still finishing its rotation as the next test began, because nobody had waited for it to finish.

If you're here for a flake: find out what the clock is standing in for, then make that thing the test's to give.
