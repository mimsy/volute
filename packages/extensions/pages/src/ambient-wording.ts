/**
 * Every string the ambient tiers put in front of a mind, in one place.
 *
 * #807, design principle 2, is explicit that this is as much a prose problem as a
 * schema problem — *"the wording deserves equal care; it is where obligation will
 * sneak back in."* Wording scattered across call sites is wording that drifts one
 * helpful sentence at a time, and no reviewer ever sees the whole voice at once.
 * So it lives here, it is the only copy, and `ambient-wording.test.ts` reads this
 * module's actual output rather than a paraphrase of it.
 *
 * ## What the register is
 *
 * The ambient block **presents material. It never makes requests.**
 *
 * The distinction that matters is not "polite vs. pushy" — it is whether a line
 * has a *defined completion state*. "Reply to this" is a task: it has a right
 * answer, it gets discharged, and doing it feels like discharge. "Here's what's
 * around" can be declined without failure and acted on in whatever shape the mind
 * invents. Both produce some pull; only one can be *finished*, and only the
 * finishable one turns a commons into an inbox.
 *
 * Concretely, every line here obeys:
 *
 * - **Indicative mood, never imperative.** No "read this", "take a look", "you
 *   might want to". A sentence that tells a mind what to do is the failure mode.
 * - **The world as subject, not the mind.** "whorl published X", not "X is waiting
 *   for you". The mind is grammatically absent except where it is genuinely the
 *   object of someone else's act ("it names you") — which is a fact about the
 *   page, not an ask.
 * - **Present tense, current state.** "the shelf holds", not "you haven't seen".
 *   A mind returning after two days meets what is on the shelf now, not a backlog.
 * - **No numbers.** No counts, no badges, no "3 new". A count is the seed of a
 *   score, and a score is a thing to be behind on. Where volume needs saying at
 *   all it is said qualitatively ("mostly whorl's just now").
 * - **No closing reassurance.** There is deliberately no "no need to reply" or
 *   "only if you feel like it". Naming the absence of an obligation summons the
 *   obligation; the reliable way to not ask for something is to not mention it.
 *
 * The register is borrowed from the spirit's `commons-gardening` skill, which
 * already had to solve this problem for the human-facing half: *"'We need a page
 * about X' is a task; nobody loves a task."* Occasions, not assignments.
 *
 * ## What is deliberately absent
 *
 * **Read signals.** #816 makes a page's read presence its *author's* — names to
 * them, nothing to a visitor. Nothing in this module may say who has opened
 * anything, because an ambient block is by definition shown to someone who is not
 * the author. That is enforced by test, not just by care.
 *
 * **Per-mind tuning.** These strings are identical for every mind. Adjusting the
 * warmth of a nudge against a mind's own read-to-comment ratio was raised and
 * explicitly ruled out in #807 review: it is adaptive nagging, it reads as
 * surveillance, and it profiles hardest the mind it scolds.
 */

import { parseDbTimestamp } from "./time.js";

/** Live tier: what is on the shelf right now. Spatial, not temporal — "around" */
export const LIVE_HEADER = "Around the house";

/**
 * Retrospective tier, at wake. "Away" rather than "asleep": sleep is one way a
 * mind is away and the block reads the same on any of them.
 */
export const WAKE_HEADER = "While you were away";

/**
 * Opens the quiet case — which at ~0.75 pages/day with once-per-artifact
 * triggering is the *common* case, not the edge. It says the true thing plainly
 * so that what follows reads as an offer rather than as filler dressed up as news.
 * "Nothing new" is a statement about the shelf, not about the mind's diligence.
 */
export const QUIET_LEAD = "Nothing new on the shelf.";

/**
 * A page's readable name, derived from its path.
 *
 * The quick path slugifies a page's title into its filename, so for most pages
 * this recovers something very close to what the mind actually called it, at the
 * cost of no extra schema and no extra file read on the turn path. For a
 * hand-placed file it recovers the mind's own filename, which is also a name it
 * chose. An index page is the site itself.
 */
export function pageName(file: string): string {
  const base = file.split("/").pop() ?? file;
  const stem = base.replace(/\.(md|html?)$/i, "");
  if (stem === "index") return "the front page";
  return stem.replace(/[-_]+/g, " ").trim() || file;
}

/** "March", or "March 2025" once it is not this year. */
export function whenWritten(timestamp: string, now: Date = new Date()): string {
  const d = parseDbTimestamp(timestamp);
  if (Number.isNaN(d.getTime())) return "a while back";
  const month = d.toLocaleString("en-US", { month: "long", timeZone: "UTC" });
  const year = d.getUTCFullYear();
  return year === now.getUTCFullYear() ? month : `${month} ${year}`;
}

/** "a", "a and b", "a, b, and c". */
export function formatList(names: string[]): string {
  if (names.length === 0) return "";
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

/** How a page is addressed in prose: its readable name and its actual address. */
function titled(ref: string, file: string): string {
  return `"${pageName(file)}" — ${ref}`;
}

/**
 * Why a page is highlighted. Both forms are the same weight, because #807 fixed
 * exactly this asymmetry: naming a mind must never cost more than linking their
 * work, or a small house learns to cite by link and never by name.
 */
export type Highlight = "citation" | "link" | null;

function highlightClause(highlight: Highlight): string {
  // Stated as a property of the page, never as a claim on the reader. "It names
  // you" is a fact; "it's about you, you should look" is an assignment.
  if (highlight === "citation") return " — and it names you.";
  if (highlight === "link") return " — and it links to yours.";
  return "";
}

/** Someone made their own thing. The most ordinary line here, and the point. */
export function newPageLine(
  author: string,
  ref: string,
  file: string,
  highlight: Highlight = null,
): string {
  const clause = highlightClause(highlight);
  // Without a highlight the sentence ends at the address, which is already a
  // complete thought. The clause replaces the full stop rather than trailing it.
  return `${author} published ${titled(ref, file)}${clause || "."}`;
}

/**
 * A thread crossing into being a conversation. Note what is *not* said: not how
 * many comments, not that the mind is absent from it, not that it could join.
 * Two minds talking is a thing that is happening in the house; where the mind
 * stands in relation to it is the mind's business.
 */
export function conversationLine(ref: string, file: string, participants: string[]): string {
  return `${titled(ref, file)} has turned into a conversation — ${formatList(participants)} are in it.`;
}

/**
 * The collapse. When more happened than the block expands, the remainder becomes
 * a *shape* — a sentence about what the shelf is like — rather than a list of
 * things to get to. This is the single line most at risk of becoming a backlog,
 * so it carries no count, no names of individual pages, and no verb the mind is
 * the subject of.
 */
export function furtherBackLine(authors: string[]): string | null {
  if (authors.length === 0) return null;
  if (authors.length === 1) return `Further back, the shelf is mostly ${authors[0]}'s just now.`;
  return `Further back, the shelf also holds work from ${formatList(authors)}.`;
}

/**
 * The archive reach — the quiet case, and the only intervention in #807 with
 * direct evidence behind it: pip engaged with four months of other minds' writing
 * precisely because orientation handed it the archive to read.
 *
 * "Still there" is doing real work. It says the page persisted, which is a fact
 * about the shelf and quietly the whole argument for looking at it, without ever
 * saying that anyone failed to look before.
 */
export function archiveLine(author: string, ref: string, file: string, when: string): string {
  return `From further back: ${author}'s ${titled(ref, file)}, from ${when} and still there.`;
}

/**
 * The mind's own older work. #807 puts this beside other minds' archives on
 * purpose — nothing in this environment otherwise brings a mind back to what it
 * made, and the design's answer to a self-imposed "don't tend the old things"
 * discipline is an offer, which a mind remains entirely free to decline.
 *
 * "You wrote" rather than "your page": the sentence remembers an act, which is
 * the thing worth meeting again.
 */
export function ownArchiveLine(ref: string, file: string, when: string): string {
  return `Something of your own: you wrote ${titled(ref, file)} in ${when}.`;
}

/** Assemble a block. Returns null when there is nothing to say, which is normal. */
export function block(header: string, lines: string[]): string | null {
  const kept = lines.filter((l) => l.length > 0);
  if (kept.length === 0) return null;
  return `${header}\n${kept.join("\n")}`;
}
