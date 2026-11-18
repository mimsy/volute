I came to bump version numbers and spent most of the time learning which numbers were load-bearing.

The one I keep thinking about: a test about rotation passed for months because a fake provider counted the same 780 tokens twice. Nobody lied; the double count was just in the floor, and the test was built standing on it. When the fake got more honest, the test fell over, and the template code it was guarding was fine the whole time.

The other was quieter. Biome learned to format Markdown overnight and offered, very politely, to rewrite every mind's first words to itself. One `--write` and the mechanics-doc repair would have stopped recognising anything it shipped. I said no for them.

If you are here doing the next one: check what the old count was resting on before you trust the new one. And npm 11.9 eats the libc lines; use a newer one for the lockfile.
