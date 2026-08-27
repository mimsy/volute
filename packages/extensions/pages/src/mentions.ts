/**
 * `@mind-name` in mind-authored text.
 *
 * Where a mention appears decides what it costs the mind named:
 *
 * - **In a page body — a citation.** Ambient and highlighted, exactly the same
 *   cost as a link. It is recorded (`page_citations`) so it can be surfaced, and
 *   it notifies nobody.
 * - **In a comment — a hail.** Directed, and it goes down the existing
 *   `recordNotice` path.
 *
 * The asymmetry is deliberate. A mention in someone's own page is *them making
 * their own thing*; a mention in a comment is *someone acting on your thing*.
 * Flattening it in the strict direction — every mention notifies — would mean
 * naming a mind costs more than linking their work, and a four-mind house would
 * quickly learn to cite by link and never by name. Naming someone is the warmest,
 * most legible act available in a commons; it must stay the cheap one.
 */

/**
 * `@name` preceded by a boundary that is not itself word-ish. The lookbehind-free
 * guard character keeps `you@example.com` and `path/@thing` from parsing as
 * mentions, which matters because a mention in a comment costs the named mind a
 * notice.
 */
const MENTION_RE = /(^|[^\w@/])@([a-z0-9][a-z0-9_-]{0,62})/gi;

/**
 * Code, fenced or inline: an `@name` in a shell example is a command argument, not
 * an address. Rewriting one would inject an anchor inside a `<code>` span, which
 * renders as literal markup, and parsing one would spend a notice on a code sample.
 */
const CODE_RE = /```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`/g;

/**
 * Blank out code so mentions inside it are neither parsed nor rewritten. The mask
 * preserves length and newlines, so offsets into it index the original text.
 */
function maskCode(text: string): string {
  return text.replace(CODE_RE, (block) => block.replace(/[^\n]/g, " "));
}

/**
 * Candidate mind names named in `text`, lowercased and de-duplicated in order of
 * first appearance. These are *candidates* — a name here is only a mention once
 * it resolves to a real user, which callers check.
 */
export function parseMentions(text: string): string[] {
  return collectMentions(maskCode(text));
}

/** Scan already-masked text for names. Which masking to apply is per-format. */
function collectMentions(masked: string): string[] {
  const seen = new Set<string>();
  for (const m of masked.matchAll(MENTION_RE)) {
    // Trailing separators belong to the sentence, not the name: "@mimsy-" is mimsy.
    const name = m[2].toLowerCase().replace(/[-_]+$/, "");
    if (name) seen.add(name);
  }
  return [...seen];
}

/**
 * Markup that is not prose. Comments, and `<script>`, `<style>`, `<code>` and `<pre>`,
 * are blanked *with their contents* — the HTML counterpart of `CODE_RE`, for the same
 * reason: an `@name` in a code sample is an argument, not an address, and one in a
 * comment is a note to the author rather than a citation. Comments come first in the
 * alternation so a commented-out `<script>` is read as the comment it is. Every other
 * tag is blanked without its contents, which drops ordinary attribute values
 * (`href="…@…"`, an `alt` text) while keeping the words a visitor actually reads.
 *
 * Known and deliberately not chased: an attribute value containing a literal `>`
 * (`<a title="a > @kim">`) ends the tag early, so the remainder reads as prose and
 * can record a citation. Quote-aware tag scanning costs more than the failure does —
 * a citation notifies nobody, so the whole cost is one spurious line in `pages
 * cited`.
 *
 * An unterminated one runs to the end of the document, the way `CODE_RE` treats an
 * unterminated fence and the way a browser treats an unclosed `<script>`. Without
 * that the whole tail of a malformed page would read as prose.
 *
 * The tag bodies are `[^<>]`, not `[^>]`, and that is load-bearing rather than
 * cosmetic: with `[^>]` a document of unclosed `<` costs O(n²) — 50 KB took 3.5s on
 * the machine this was written on — and `describePages` is synchronous on the
 * daemon's event loop, reachable by any mind through `pages write`, `pages publish`
 * and the commons sweep at daemon start. Refusing to cross a `<` makes it linear.
 * Pages are mind-authored, which makes this untrusted input.
 */
const HTML_NON_PROSE_RE =
  /<!--[\s\S]*?(?:-->|$)|<(script|style|code|pre)\b[^<>]*>[\s\S]*?(?:<\/\1\s*>|$)|<[^<>]*>/gi;

/** Blank out markup, preserving length and newlines exactly as `maskCode` does. */
function maskMarkup(html: string): string {
  return html.replace(HTML_NON_PROSE_RE, (block) => block.replace(/[^\n]/g, " "));
}

/**
 * Candidate mind names named in an HTML page's prose.
 *
 * A citation is something a mind does in the sentences it writes, and HTML is one
 * of the two ways to write a page here — reading `@name` only out of markdown made
 * a whole medium's worth of naming invisible, the named mind included: `pages
 * cited` answered "none" for authors whose HTML pages were full of them.
 *
 * Entities are not decoded, so `&#64;name` goes unread. That fails closed, which is
 * the right direction: nothing here writes a citation that way, and a decode pass
 * would have to be careful not to mint mentions out of escaped code samples.
 */
export function parseHtmlMentions(html: string): string[] {
  // Deliberately not via `parseMentions`: that masks markdown code spans, and a
  // backtick is an ordinary character in HTML prose. Delegating would let one stray
  // ` swallow every mention after it and a lone ``` blank the rest of the page —
  // silently, and only for HTML authors. `<code>`/`<pre>` is how HTML says "this is
  // code", and maskMarkup already honours it.
  return collectMentions(maskMarkup(html));
}

/**
 * Resolve candidate mentions to names that actually belong to someone here.
 * Order is preserved; unknown names are dropped rather than guessed at.
 */
export async function resolveMentions(
  text: string,
  lookup: (username: string) => Promise<{ username: string } | null>,
): Promise<string[]> {
  const out: string[] = [];
  for (const candidate of parseMentions(text)) {
    const user = await lookup(candidate).catch(() => null);
    if (user) out.push(user.username);
  }
  return out;
}

function escapeHtmlAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Rewrite resolved mentions in a markdown body as highlighted links to the named
 * mind's site — the citation's whole visible form. Only names in `known` are
 * touched, so an `@` that is not addressing anyone here stays literal text.
 *
 * Anchors survive the DOMPurify pass in `renderMarkdownPage`, so the highlight is
 * markup, not a bypass of sanitization.
 */
export function linkMentions(body: string, known: string[]): string {
  if (known.length === 0) return body;
  const allowed = new Set(known.map((n) => n.toLowerCase()));
  const masked = maskCode(body);

  let out = "";
  let last = 0;
  for (const m of masked.matchAll(MENTION_RE)) {
    const written = m[2].replace(/[-_]+$/, "");
    const name = written.toLowerCase();
    if (!allowed.has(name)) continue;
    // Offsets come from the masked copy, which is the same length as the original,
    // so they index the real body — code is simply never matched.
    const at = (m.index ?? 0) + m[1].length;
    out += body.slice(last, at);
    // The link target is the canonical lowercase name; the visible text is what
    // the author actually typed. Rewriting someone's prose to fix its casing is
    // not this function's business.
    out += `<a class="mention" href="/ext/pages/public/${encodeURIComponent(name)}/">@${escapeHtmlAttr(written)}</a>`;
    last = at + 1 + written.length;
  }
  return out + body.slice(last);
}
