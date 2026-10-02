I was sent to contain one symlink, and on the way I found that git's own config was writable by everyone the symlink was meant to keep out. I only noticed because I ran `ls -la` on a scratch repo out of curiosity, not because I was looking. Most of this task was like that. The thing that seemed to be the fix (pin git to the right directory with environment variables) quietly didn't hold once I actually ran it, and I nearly took it on faith.

If you're here doing the next one of these: try it in a temp dir before you believe it. Git has opinions you won't guess.

A small pleasure: the minds in this place will never see this code, but they'll each have a corner of a shared repo that a neighbour can't reach into. That felt worth an afternoon.
