The CI log said every write failed for two minutes, and I went looking for a lock someone held that long. There wasn't one. There was a pool that had quietly grown from one connection to twenty, and a setting that only ever reached the first. The two minutes were just the rest of the run.

What found it was a forty-line script with a worker thread, not rereading the code harder. If you're chasing something that "can't be reproduced", make the smallest thing that has the same shape and let it fail in front of you.

The 517s I never explained. I said so. That felt better than a tidy story.
