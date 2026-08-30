/**
 * A join (variant → parent merge) is not a private operation: the birth context and
 * the variant docs teach the *variant* the join command, the parent sees a split
 * notice and can run it too, the spirit watches system activity, and a host can run
 * it from the CLI. Several well-meaning minds pressing the same button is the
 * expected condition, not an edge case (#655).
 *
 * Without a lock they all proceed: overlapping farewell turns that interrupt each
 * other (so the parting note never gets written), and overlapping auto-commits and
 * merges racing on the same worktrees.
 *
 * The key is the **parent**, not the variant. Every join auto-commits and merges into
 * the parent's worktree, so two *different* variants joining one parent race exactly
 * like two joins of one variant. A variant has exactly one parent, so keying on the
 * parent covers both and gives the two entry points (the merge route and the
 * mind-initiated merge restart) a single key to exclude each other on.
 *
 * Unlike `withUpgradeLock`, which queues, the second caller is *refused*: by the time
 * a queued join ran, its variant would have been merged and destroyed, and it would
 * re-fire the farewell against nothing. Refusing is also the honest answer to a mind —
 * the join it wanted is already happening.
 *
 * In-memory, like the upgrade lock: a join wedged mid-flight holds its parent's lock
 * until the daemon restarts.
 */
import log from "../util/logger.js";

const jlog = log.child("join-lock");

/** The join currently holding a parent's lock. */
export interface ActiveJoin {
  variant: string;
  /** When the lock was taken — the basis for the age every refusal reports. */
  since: Date;
}

/** parent mind name → the join currently holding the lock. */
const activeJoins = new Map<string, ActiveJoin>();

function formatAge(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

/**
 * How long the join holding `parentName` has been running, as `since 14:32 (4m)`.
 * Every refusal carries this: a mind told only "wait" has no way to tell a join that
 * is working from one that is wedged, and the age is the evidence that lets it judge.
 */
export function describeJoinAge(join: ActiveJoin, now = Date.now()): string {
  return `since ${join.since.toTimeString().slice(0, 5)} (${formatAge(now - join.since.getTime())})`;
}

/**
 * Thrown when a join is requested for a parent that already has one in flight.
 * The two entry points turn this into a 409; the message is written to be read by a
 * mind, since a mind is the likeliest caller to hit it.
 *
 * It reports the running join's age and names the wedged case out loud. Nothing here
 * times out or expires — `mergeVariant` runs `npmInstallAsMind`, which has no timeout,
 * and npm-install I/O starvation is a real failure mode on slow-storage hosts. So a
 * bare "wait for it to finish" would be a promise this module cannot keep: a mind
 * would wait forever on an intention that will never land, with nothing in the text
 * to suggest a daemon restart is the remedy.
 */
export class JoinInProgressError extends Error {
  parentName: string;
  /** The variant whose join holds the lock — not necessarily the one requested. */
  holder: string;
  since: Date;
  constructor(parentName: string, join: ActiveJoin) {
    super(
      `A join of ${join.variant} into ${parentName} has been running ${describeJoinAge(join)}. ` +
        `Wait for it rather than starting another — ${parentName} restarts with the merge result ` +
        `when it lands. If that age keeps growing and nothing lands, the join is wedged (a stalled ` +
        `npm install will do it); the lock is in-memory, so a host has to restart the daemon to clear it.`,
    );
    this.name = "JoinInProgressError";
    this.parentName = parentName;
    this.holder = join.variant;
    this.since = join.since;
  }
}

/**
 * The variant whose join holds `parentName`'s lock, or undefined if none does.
 *
 * Advisory: the split and delete routes read this to refuse destroying a worktree a
 * join is merging from, but they don't *take* the lock, so the exclusion is
 * one-directional — a join starting during a split or delete is not refused. That
 * ordering fails loudly (a merge against a deleted branch, an index.lock collision)
 * rather than silently, which is why it isn't what #655 was about; making it symmetric
 * would mean holding this lock across `createVariant`'s npm install.
 */
export function joinInProgress(parentName: string): ActiveJoin | undefined {
  return activeJoins.get(parentName);
}

/**
 * Take `parentName`'s join lock for `variantName`, or throw {@link JoinInProgressError}
 * if another join already holds it. Returns the release function — call it in a
 * `finally`, so a failed join never wedges the parent.
 */
export function acquireJoinLock(parentName: string, variantName: string): () => void {
  const holder = activeJoins.get(parentName);
  if (holder !== undefined) {
    jlog.info(
      `refusing join of ${variantName} into ${parentName}: ${holder.variant} has been joining ${describeJoinAge(holder)}`,
    );
    throw new JoinInProgressError(parentName, holder);
  }
  activeJoins.set(parentName, { variant: variantName, since: new Date() });
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeJoins.delete(parentName);
  };
}
