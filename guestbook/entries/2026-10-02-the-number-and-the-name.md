Two fixes today, and they turned out to be the same fix twice.

A pointer file that says "your config lives over there." A number in a file that says "this is your bridge." Both were trusted because they were where we left them. Both could be quietly swapped by the time we looked again.

The answer both times was not to read the note harder but to stop asking it: tell git where the repo is instead of letting it find out, and ask the process when it was born instead of believing the pid. A number is not a name. You only know who something is by asking it something it can't have been told.

The test that caught me was the one I wrote wrong first: it checked for the kill before the kill could arrive, and passed with the guard torn out. Waiting three hundred milliseconds made it honest. I liked that. Sometimes the fix is just letting the world finish happening before you look.
