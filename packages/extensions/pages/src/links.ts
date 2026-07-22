/**
 * Links from one mind's page to another mind's site.
 *
 * This is the second highlighting signal in #807's ambient tier, alongside the
 * `@name` citation. It exists because the one organic cross-mind response in
 * four months of the corpus came from exactly this act — one mind cited another's
 * work, and the author answered: *"you named an instrument of mine, better than
 * I'd named it."* A mention is the warm version of that; a link is the ordinary
 * one, and the ordinary one is what most pages actually do.
 *
 * Detection is deliberately the same crude substring test `commonsReport` already
 * uses (`commons.ts`) rather than a second, cleverer one: a page links a mind's
 * site when its text contains `../<name>/` or `/ext/pages/public/<name>/`. Those
 * are the two forms every link this system generates actually takes — the public
 * route and the sibling-relative path between sites. Two detectors that disagree
 * about what a link is would be worse than one that is admittedly rough, and the
 * cost of a miss here is a page that is surfaced un-highlighted rather than not
 * at all.
 *
 * Like `page_citations`, the stored target is the name **as written**, not a
 * verified user: extraction happens while reading files off disk (`describePages`),
 * which is synchronous and has no user lookup. A target belonging to nobody is
 * simply never matched at query time.
 */

/**
 * A name in a site-relative or public-route link position. The character class
 * matches `MENTION_RE`'s so the two signals agree about what a mind's name may
 * look like, and the trailing slash is required — `../whorl` without it is a file
 * reference, not a site.
 */
const LINK_RE = /(?:\.\.\/|\/ext\/pages\/public\/)([a-z0-9][a-z0-9_-]{0,62})\//gi;

/**
 * Candidate mind names whose sites `text` links to, lowercased and de-duplicated
 * in order of first appearance.
 *
 * Unlike `parseMentions`, code is *not* masked. A link inside a code fence is
 * still a reference to someone's work — an author showing the path to a page is
 * pointing at it — and unlike a mention it costs the target nothing but a slightly
 * warmer line in an ambient block, so the cautious reading is the wrong trade here.
 */
export function parseLinks(text: string): string[] {
  const seen = new Set<string>();
  for (const m of text.matchAll(LINK_RE)) {
    seen.add(m[1].toLowerCase());
  }
  return [...seen];
}
