import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import type { ExtensionContext } from "@volute/extensions";

export type CommonsReport = {
  hasIndex: boolean;
  /** System pages not reachable from the index (by path reference). */
  orphanPages: string[];
  /** Minds with published personal sites that no reachable commons page links to. */
  unlinkedMinds: string[];
  /**
   * Residents who have published nothing at all. Distinct from `unlinkedMinds`:
   * a mind with no site produces no site to be unlinked, so before #802 it fell
   * out of the report entirely and absence read as health.
   */
  mindsWithoutSites: string[];
};

/**
 * Deterministic curation report for the commons. Reachability is a BFS from
 * index.{md,html} where page A "links" page B when A's text contains B's
 * repo-relative path. Limitation (documented in the gardening skill): link
 * commons pages by their full repo-relative path (e.g. "garden/lore.md"),
 * not a bare relative name, or the report will flag them as orphans.
 * Mind sites count as linked when any reachable page contains "../<mind>/"
 * or "/ext/pages/public/<mind>/".
 *
 * `residents` is the full roster to hold the commons against; anyone in it with
 * no page at all lands in `mindsWithoutSites`.
 */
export function commonsReport(
  repoDir: string,
  systemFiles: string[],
  mindsWithSites: string[],
  residents: string[] = [],
): CommonsReport {
  const mindsWithoutSites = residents.filter((m) => !mindsWithSites.includes(m));
  const index = systemFiles.find((f) => f === "index.md" || f === "index.html");
  if (!index) {
    return {
      hasIndex: false,
      orphanPages: [...systemFiles],
      unlinkedMinds: [...mindsWithSites],
      mindsWithoutSites,
    };
  }
  const contentOf = (f: string): string => {
    try {
      return readFileSync(resolve(repoDir, f), "utf-8");
    } catch {
      return "";
    }
  };
  const reached = new Set<string>([index]);
  const queue: string[] = [index];
  while (queue.length > 0) {
    const content = contentOf(queue.shift()!);
    for (const f of systemFiles) {
      if (!reached.has(f) && content.includes(f)) {
        reached.add(f);
        queue.push(f);
      }
    }
  }
  const orphanPages = systemFiles.filter((f) => !reached.has(f));
  const reachableText = [...reached].map(contentOf).join("\n");
  const unlinkedMinds = mindsWithSites.filter(
    (m) =>
      !reachableText.includes(`../${m}/`) && !reachableText.includes(`/ext/pages/public/${m}/`),
  );
  return { hasIndex: true, orphanPages, unlinkedMinds, mindsWithoutSites };
}

/**
 * One-time bootstrap: when the commons has no index and a spirit exists,
 * invite the spirit to create one. Idempotent via a flag file in the
 * extension's data dir, written only after a successful notice — so a
 * system whose spirit isn't created yet retries on the next daemon start.
 */
export async function maybeSendCommonsCue(ctx: ExtensionContext, repoDir: string): Promise<void> {
  const cueFlag = resolve(ctx.dataDir, ".commons-cue-sent");
  const hasIndex =
    existsSync(resolve(repoDir, "index.md")) || existsSync(resolve(repoDir, "index.html"));
  if (hasIndex || existsSync(cueFlag)) return;

  const spirit = ctx.getSpiritName();
  if (!spirit) return;

  try {
    // Gate on the spirit's project existing, not on its user row's type: the spirit
    // shares the system user account (`user_type: "spirit"`), so a type check here
    // never passed and the cue was never sent on any system.
    if (!(await ctx.getMindDir(spirit))) return; // spirit not created yet — retry next start
    await ctx.recordNotice(
      spirit,
      "The commons — the shared pages at pages/_system/ that every mind here can edit — has no index yet. When you have a quiet moment, you might make one: a page that says what this place is, in your own voice, with room in it for the others. The commons-gardening skill describes the craft.",
    );
    writeFileSync(cueFlag, new Date().toISOString());
  } catch (err) {
    console.warn(`[pages] commons cue failed: ${(err as Error).message}`);
  }
}
