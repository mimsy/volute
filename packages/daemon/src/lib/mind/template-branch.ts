import { gitExec } from "../util/exec.js";

/** The branch tracking the composed template files a mind's upgrades merge from. */
export const TEMPLATE_BRANCH = "volute/template";

/**
 * True when HEAD and volute/template have a merge base, so an upgrade merges 3-way.
 * Only git's own "no" answers (exit 1) read as false; any other failure throws,
 * since a false here rebuilds the base from HEAD and hands the mind the template's
 * version of every template file it edited. `git` is the caller's options for the
 * mind's repo — `mindGitOpts` on the daemon, where the repo's config is the mind's.
 */
export async function sharesTemplateBase(git: Parameters<typeof gitExec>[1]): Promise<boolean> {
  const answer = async (args: string[]) => {
    try {
      await gitExec(args, git);
      return true;
    } catch (err) {
      if ((err as { code?: unknown }).code === 1) return false;
      throw err;
    }
  };
  return (
    (await answer(["rev-parse", "--verify", "--quiet", `refs/heads/${TEMPLATE_BRANCH}`])) &&
    (await answer(["merge-base", "HEAD", TEMPLATE_BRANCH]))
  );
}
