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
 *
 * A template upgrade merges into the same worktree, so a join and an upgrade of one
 * mind exclude each other too (#988) — each refuses while the other is in flight,
 * rather than queuing across the two. The upgrade side registers here via
 * {@link beginUpgrade}, called by `withUpgradeLock`, so both halves of the exclusion
 * live in one module and are checked synchronously against each other.
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
  return describeSince(join.since, now);
}

function describeSince(since: Date, now = Date.now()): string {
  return `since ${since.toTimeString().slice(0, 5)} (${formatAge(now - since.getTime())})`;
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

/** An in-flight run of upgrade operations (queued or running) for one mind. */
interface ActiveUpgrade {
  /** Upgrade operations queued or running under `withUpgradeLock`. */
  count: number;
  /** When the current run of upgrades began. */
  since: Date;
}

/** mind name → its in-flight upgrade operations. */
const activeUpgrades = new Map<string, ActiveUpgrade>();

/** Thrown by {@link acquireJoinLock} when an upgrade of the parent is in flight. */
export class JoinBlockedByUpgradeError extends Error {
  parentName: string;
  constructor(parentName: string, upgrade: ActiveUpgrade) {
    super(
      `A template upgrade of ${parentName} has been running ${describeSince(upgrade.since)}, ` +
        `and it merges into the same worktree a join would. Try the join again when it finishes. ` +
        `If that age keeps growing, the upgrade is wedged (a stalled npm install will do it); the ` +
        `lock is in-memory, so a host has to restart the daemon to clear it.`,
    );
    this.name = "JoinBlockedByUpgradeError";
    this.parentName = parentName;
  }
}

/** Thrown by {@link beginUpgrade} when a variant join into the mind is in flight. */
export class UpgradeBlockedByJoinError extends Error {
  mindName: string;
  /** The variant whose join holds the lock. */
  holder: string;
  constructor(mindName: string, join: ActiveJoin) {
    super(
      `A variant join of ${join.variant} into ${mindName} has been running ${describeJoinAge(join)}, ` +
        `and it merges into the same worktree an upgrade would. Try the upgrade again when it ` +
        `finishes. If that age keeps growing, the join is wedged; the lock is in-memory, so a host ` +
        `has to restart the daemon to clear it.`,
    );
    this.name = "UpgradeBlockedByJoinError";
    this.mindName = mindName;
    this.holder = join.variant;
  }
}

/**
 * Register one upgrade operation for `mindName`, or throw {@link UpgradeBlockedByJoinError}
 * if a join into it is in flight. Returns the release function; a join is refused from
 * this call until every registered operation has released.
 */
export function beginUpgrade(mindName: string): () => void {
  const join = activeJoins.get(mindName);
  if (join !== undefined) {
    jlog.info(
      `refusing upgrade of ${mindName}: ${join.variant} has been joining ${describeJoinAge(join)}`,
    );
    throw new UpgradeBlockedByJoinError(mindName, join);
  }
  const upgrade = activeUpgrades.get(mindName);
  if (upgrade) upgrade.count++;
  else activeUpgrades.set(mindName, { count: 1, since: new Date() });
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = activeUpgrades.get(mindName)!;
    if (--current.count === 0) activeUpgrades.delete(mindName);
  };
}

/**
 * Take `parentName`'s join lock for `variantName`, or throw {@link JoinInProgressError}
 * if another join already holds it, or {@link JoinBlockedByUpgradeError} if an upgrade
 * of the parent is in flight. Returns the release function — call it in a
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
  const upgrade = activeUpgrades.get(parentName);
  if (upgrade !== undefined) {
    jlog.info(`refusing join of ${variantName} into ${parentName}: an upgrade is in flight`);
    throw new JoinBlockedByUpgradeError(parentName, upgrade);
  }
  activeJoins.set(parentName, { variant: variantName, since: new Date() });
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeJoins.delete(parentName);
  };
}
