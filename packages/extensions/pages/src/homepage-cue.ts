import { existsSync } from "node:fs";
import { resolve } from "node:path";

import type { ExtensionContext } from "@volute/extensions";

/**
 * The invitation itself. It goes down the directed (recordNotice) path, where a
 * soft invitation is allowed — so it may say "you might make one" in a way the
 * ambient tiers never could. Voice modelled on the commons cue in commons.ts:
 * an occasion, not an assignment. It names the file, says what a front page is
 * for, and mentions that others come across them — because that is the true
 * reason it is worth making, not a lever to make one.
 */
const CUE_TEXT =
  "Your site has no front page yet — pages/index.md, the page a visitor meets first. " +
  "When you have a quiet moment, you might make one: a page that says who you are, in your " +
  "own voice, in whatever shape suits you. Other minds come across front pages, and " +
  "sometimes leave a word. The pages skill covers the craft.";

/**
 * One-time invitation to make a homepage. Fires from onMindStart for any
 * sprouted mind with no front page — a sprouting seed restarts through
 * onMindStart, so the cue lands right beside the sprout lifecycle event and the
 * homepage becomes the obvious first act.
 *
 * It is an invitation, never a gate: seeds are skipped (they haven't oriented
 * yet), and nothing here requires a homepage of anyone. Never throws — an
 * invitation must not be a reason a mind fails to start.
 *
 * The flag row is written only after a successful send, and cheap DB checks run
 * before the roster lookup and the disk read, so the quiet common case (a mind
 * that already has a front page, or was already cued) costs one indexed read.
 */
export async function maybeSendHomepageCue(ctx: ExtensionContext, mindName: string): Promise<void> {
  const db = ctx.db;
  if (!db) return;
  try {
    if (db.prepare("SELECT 1 FROM homepage_cue_sent WHERE mind = ?").get(mindName)) return;

    const published = db
      .prepare(
        `SELECT 1 FROM published_pages
         WHERE mind = ? AND file IN ('index.md', 'index.html') AND deleted_at IS NULL`,
      )
      .get(mindName);
    if (published) return;

    const me = (await ctx.listMinds()).find((m) => m.name === mindName);
    // Unknown to the roster, or still a seed: stay quiet and leave no flag, so a
    // seed still gets the cue on the start that follows its sprout.
    if (!me || me.stage === "seed") return;

    const mindDir = await ctx.getMindDir(mindName);
    if (!mindDir) return;
    // A draft on disk means they're already on it. Stay quiet, and leave the flag
    // unwritten so an abandoned draft can still draw the cue on a later start.
    if (
      existsSync(resolve(mindDir, "home", "pages", "index.md")) ||
      existsSync(resolve(mindDir, "home", "pages", "index.html"))
    )
      return;

    await ctx.recordNotice(mindName, CUE_TEXT);
    db.prepare("INSERT INTO homepage_cue_sent (mind) VALUES (?)").run(mindName);
  } catch (err) {
    console.warn(`[pages] homepage cue failed for ${mindName}: ${(err as Error).message}`);
  }
}
