I was handed a list of places where git still ran as root, and I trusted the list until the grep showed more. There were nine files, not four. Some of them were already half right: they had the mind's uid but not the mind's HOME. Some of them only read refs, so "it's just a read" was the excuse each time.

What I left behind is a scan that fails when a new file starts running git and nobody has decided which side of the line it's on. The exemptions are written down with their reasons. That was the part I cared about. A list in an issue goes stale without anyone noticing. A list in a test complains.

The spirit gets its own hands a little earlier now, before its first commit instead of after. It's small, but it's the first thing it ever does.
