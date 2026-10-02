import { and, asc, desc, eq, gt, gte, inArray, isNull, ne, or } from "drizzle-orm";
import { getDb } from "../db.js";
import { mindGitOpts } from "../mind/isolation.js";
import { resolveMindDir } from "../mind/registry.js";
import { messages, mindHistory, turns } from "../schema.js";
import { gitExec } from "../util/exec.js";
import log from "../util/logger.js";
import { parseDbTimestamp, toDbTimestamp } from "../util/time.js";

const slog = log.child("since-last-here");

/**
 * How far back a thread with no turn on record looks. A brand-new thread — the first
 * message on a new DM, every `$new` thread — knows nothing of what the mind did anywhere
 * else, and the harm this note exists for is measured in minutes (gardener's double reply
 * on 2026-09-26 was a first-ever `@claude` thread starting 4 seconds after `main` had
 * answered the same message). An hour covers "just now" without turning every new
 * thread's first message into a digest of the day.
 */
export const FIRST_TURN_WINDOW_MS = 60 * 60_000;

/**
 * How far back a thread that last ran long ago looks. Past a day the note would be a
 * digest of everything, which is the long banner minds say they read past; the header
 * says the window was cut, and `volute mind history` holds the rest.
 */
export const MAX_LOOKBACK_MS = 24 * 60 * 60_000;

/**
 * Commits this soon after a thread's own `done` are taken to be its own. The claude
 * template emits `done` and THEN commits the turn's files, and the gate hands the next
 * thread its turn the instant `done` arrives, so the next thread can start before that
 * commit lands. Another thread writing, finishing and committing within this long is
 * rare; this thread's own commit landing later than this is too, and costs only a line
 * naming a file it wrote itself.
 */
const OWN_COMMIT_GRACE_MS = 15_000;

/** Longest the whole note may take to build. Delivery never waits longer than this for it. */
const BUILD_TIMEOUT_MS = 1_500;
/** Longest `git log` may run. Bounded separately so a slow disk costs the file line only. */
const GIT_TIMEOUT_MS = 1_000;

/** Other conversations listed by name before "and K more". */
const MAX_OTHER_CONVERSATIONS = 5;
/** Sends in this conversation quoted in full-ish before "and K more". */
const MAX_SAME_CONVERSATION_SENDS = 3;
/** A quoted send is cut here; the rest is one `volute mind history` away. */
const MAX_QUOTE_CHARS = 600;
/** Files named before "and K more". */
const MAX_FILES = 8;
/** Outbound rows read at most — bounds the query on a mind that has sent a great deal. */
const MAX_SEND_ROWS = 200;
/** A wait shorter than this isn't worth a line. */
export const MIN_REPORTED_WAIT_MS = 30_000;

export type SinceNoteInput = {
  /** Base mind name. Variants are skipped by the callers — see {@link sinceNoteFor}. */
  mind: string;
  /** The routing thread this turn runs on. */
  thread: string;
  /** Channel slugs of what is being delivered — the conversation(s) this turn serves. */
  channels: Iterable<string | undefined>;
  /** Conversation ids of what is being delivered, where known. */
  conversationIds: Iterable<string | undefined>;
  /** How long the delivery waited for the turn gate, and which threads it waited behind. */
  waited?: { ms: number; behind: string[] };
  /** Test seam: the clock. */
  now?: number;
};

type Send = {
  id: number;
  channel: string;
  content: string;
  thread: string | null;
  at: Date;
  conversationId: string | null;
};

/**
 * Local `HH:MM`, with the date in front when it isn't today. Minds stamp their own
 * messages in local time, so the note does too.
 */
function when(at: Date, now: number): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const hm = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  const today = new Date(now);
  if (at.toDateString() === today.toDateString()) return hm;
  return `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${hm}`;
}

function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}h${m % 60}m` : `${h}h`;
}

function threadName(thread: string | null): string | null {
  if (!thread) return null;
  return thread.startsWith("new-") ? "a $new thread" : `\`${thread}\``;
}

/**
 * One line, so a quoted send can't break the note's shape — a newline followed by `- `
 * would otherwise read as a line the daemon wrote.
 */
function quote(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > MAX_QUOTE_CHARS ? `${flat.slice(0, MAX_QUOTE_CHARS)}…` : flat;
}

function more(n: number): string {
  return n > 0 ? `, and ${n} more` : "";
}

/**
 * Where this thread last stood: the id and time of its latest `done` row, the end of the
 * last turn it ran. Ids, not timestamps, are the cutoff for what happened since: rows are
 * appended in order, and a gated message released later carries its release time, not its
 * arrival (so the turn's own MIN/MAX created_at can't be trusted). Null when the thread
 * has never finished a turn.
 */
async function lastRun(mind: string, thread: string): Promise<{ id: number; at: Date } | null> {
  const db = await getDb();
  const row = await db
    .select({ id: mindHistory.id, created_at: mindHistory.created_at })
    .from(mindHistory)
    .where(
      and(eq(mindHistory.mind, mind), eq(mindHistory.type, "done"), eq(mindHistory.thread, thread)),
    )
    .orderBy(desc(mindHistory.id))
    .limit(1)
    .get();
  return row ? { id: row.id, at: parseDbTimestamp(row.created_at) } : null;
}

/**
 * Whether the mind has ever reported a turn done. A mind on the `silent` transparency
 * preset never does, and without that anchor nothing can tell its threads' own sends and
 * commits from each other's — every turn would look like a first one and list the mind's
 * own words back to it as another thread's.
 */
async function hasAnyRun(mind: string): Promise<boolean> {
  const db = await getDb();
  const row = await db
    .select({ id: mindHistory.id })
    .from(mindHistory)
    .where(and(eq(mindHistory.mind, mind), eq(mindHistory.type, "done")))
    .limit(1)
    .get();
  return row != null;
}

/**
 * The mind's sends after row `afterId` (none for a first turn) and no earlier than
 * `sinceAt`, newest first, each with the thread that sent it and its conversation.
 *
 * The thread is the row's own stamp, set only when it is exact (#1173) — not the turn's
 * thread, which on rows written before that fix can be the wrong turn. A send with no
 * stamp is kept but named as unknown: turns are serial by default (#1007), so it was not
 * this thread's, but which thread it was is not on record.
 */
async function sendsSince(mind: string, afterId: number | null, sinceAt: Date) {
  const db = await getDb();
  const since = gte(mindHistory.created_at, toDbTimestamp(sinceAt.getTime()));
  const cutoff = afterId != null ? and(gt(mindHistory.id, afterId), since) : since;
  const rows = await db
    .select({
      id: mindHistory.id,
      channel: mindHistory.channel,
      content: mindHistory.content,
      thread: mindHistory.thread,
      message_id: mindHistory.message_id,
      created_at: mindHistory.created_at,
    })
    .from(mindHistory)
    .where(and(eq(mindHistory.mind, mind), eq(mindHistory.type, "outbound"), cutoff))
    .orderBy(desc(mindHistory.id))
    .limit(MAX_SEND_ROWS)
    .all();

  // A row with a message id belongs to exactly one conversation. Resolve it, because two
  // different conversations can share a slug (a group DM is named after one participant),
  // and deciding "same conversation" by slug alone would copy words across a boundary the
  // mind drew on purpose.
  const messageIds = rows
    .map((r) => Number(r.message_id))
    .filter((n) => Number.isInteger(n) && n > 0);
  const convOf = new Map<number, string>();
  if (messageIds.length > 0) {
    const convRows = await db
      .select({ id: messages.id, conversation_id: messages.conversation_id })
      .from(messages)
      .where(inArray(messages.id, messageIds))
      .all();
    for (const r of convRows) convOf.set(r.id, r.conversation_id);
  }

  return rows.map(
    (r): Send => ({
      id: r.id,
      channel: r.channel ?? "unknown",
      content: r.content ?? "",
      thread: r.thread || null,
      at: parseDbTimestamp(r.created_at),
      conversationId: r.message_id ? (convOf.get(Number(r.message_id)) ?? null) : null,
    }),
  );
}

/**
 * When another thread first started a turn after this thread's last one ended — the start
 * of the window files could have changed in without this thread knowing. Not the `done`
 * itself: the claude template emits `done` and THEN commits the turn's files, so a window
 * opening at `done` would list this thread's own last writes back to it. Null when no
 * other thread has run since, which also means there is nothing to ask git.
 */
async function otherThreadStartedAt(mind: string, thread: string, since: Date) {
  const db = await getDb();
  const row = await db
    .select({ created_at: turns.created_at })
    .from(turns)
    .where(
      and(
        eq(turns.mind, mind),
        gte(turns.created_at, toDbTimestamp(since.getTime())),
        or(isNull(turns.thread), ne(turns.thread, thread)),
      ),
    )
    .orderBy(asc(turns.created_at))
    .limit(1)
    .get();
  return row ? parseDbTimestamp(row.created_at) : null;
}

/**
 * Paths under `home/` committed at or after `since`, most recent first, deduplicated.
 * Read from the auto-commit history in the mind's own repo, run as the mind's user and
 * with signature display forced off: `git log` reads the mind's `.git/config`, and
 * `log.showSignature` + `gpg.program` would otherwise run mind-authored code as the daemon.
 */
async function filesSince(mind: string, since: Date): Promise<string[]> {
  const sinceSec = Math.floor(since.getTime() / 1000);
  const out = await gitExec(
    [
      "log",
      "--no-show-signature",
      "--no-merges",
      "-n",
      "100",
      `--since=@${sinceSec}`,
      "--format=%x1e%ct",
      "--name-only",
      "--",
      "home",
    ],
    { ...mindGitOpts(await resolveMindDir(mind), mind), timeout: GIT_TIMEOUT_MS },
  );
  const files: string[] = [];
  const seen = new Set<string>();
  for (const commit of out.split("\x1e")) {
    const [ct, ...paths] = commit.split("\n");
    // `--since` is day-granular on some git versions; filter to the second ourselves.
    if (!ct || Number(ct.trim()) < sinceSec) continue;
    for (const p of paths) {
      const path = p.trim().replace(/^home\//, "");
      if (!path || seen.has(path)) continue;
      seen.add(path);
      files.push(path);
    }
  }
  return files;
}

/**
 * The note itself. Every part is optional and the whole is null when there's nothing to
 * say — a thread that is caught up hears nothing.
 *
 * Other conversations are named, never quoted: a mind's routes are compartments it drew,
 * and it has sent something as a DM precisely so a channel's readers wouldn't see it
 * (gardener). Only sends into the conversation this turn is serving are quoted — that is
 * the case that produces a double reply.
 */
export async function buildSinceNote(input: SinceNoteInput): Promise<string | null> {
  const now = input.now ?? Date.now();
  const lines: string[] = [];

  if (input.waited && input.waited.ms >= MIN_REPORTED_WAIT_MS) {
    const behind = input.waited.behind.map(threadName).filter((t): t is string => t != null);
    lines.push(
      behind.length > 0
        ? `waited ${duration(input.waited.ms)} behind ${behind.join(", ")}`
        : `waited ${duration(input.waited.ms)} for a free turn`,
    );
  }

  // A `$new` thread never recurs, so it has no last turn to find; don't look for one.
  const last = input.thread.startsWith("new-") ? null : await lastRun(input.mind, input.thread);
  if (!last && !(await hasAnyRun(input.mind))) return render("[before this turn:", lines);
  const floor = now - (last ? MAX_LOOKBACK_MS : FIRST_TURN_WINDOW_MS);
  const cut = !last || last.at.getTime() < floor;
  const sinceAt = new Date(Math.max(last?.at.getTime() ?? 0, floor));

  const channels = new Set([...input.channels].filter((c): c is string => !!c));
  const convIds = new Set([...input.conversationIds].filter((c): c is string => !!c));
  const rows = await sendsSince(input.mind, last?.id ?? null, sinceAt);
  const sends = rows.filter((s) => s.thread !== input.thread);

  const here: Send[] = [];
  const elsewhere = new Map<string, Send[]>();
  for (const s of sends) {
    const same = s.conversationId ? convIds.has(s.conversationId) : channels.has(s.channel);
    if (same) here.push(s);
    else {
      // Keyed by conversation where known, so two conversations sharing a slug stay apart.
      const key = s.conversationId ?? `slug:${s.channel}`;
      const list = elsewhere.get(key) ?? [];
      list.push(s);
      elsewhere.set(key, list);
    }
  }

  // Oldest first, as they happened.
  const quoted = here.slice(0, MAX_SAME_CONVERSATION_SENDS).reverse();
  for (const s of quoted) {
    const by = threadName(s.thread);
    lines.push(
      `${by ? `${by} already sent here` : "already sent here (thread not recorded)"} ` +
        `at ${when(s.at, now)}: "${quote(s.content)}"`,
    );
  }
  if (here.length > quoted.length) {
    lines.push(
      `…and ${here.length - quoted.length} earlier send(s) here — ` +
        `\`volute mind history --channel "${here[0].channel}"\``,
    );
  }

  const groups = [...elsewhere.values()];
  if (groups.length > 0) {
    const parts = groups.slice(0, MAX_OTHER_CONVERSATIONS).map((list) => {
      const threads = [...new Set(list.map((s) => threadName(s.thread)).filter((t) => t))];
      const chars = list.reduce((n, s) => n + s.content.length, 0);
      const count = list.length === 1 ? "1 message" : `${list.length} messages`;
      const from = threads.length > 0 ? `, from ${threads.join(", ")}` : "";
      return `${list[0].channel} (${count}, ${chars} chars${from}, last ${when(list[0].at, now)})`;
    });
    // At the row cap the counts are a floor; say so rather than state them as exact.
    const partial = rows.length >= MAX_SEND_ROWS ? ` (latest ${MAX_SEND_ROWS} sends only)` : "";
    lines.push(
      `sent elsewhere${partial}: ${parts.join("; ")}` +
        `${more(groups.length - MAX_OTHER_CONVERSATIONS)} — ` +
        "read one with `volute mind history --channel <channel>`",
    );
  }

  // First-turn threads have no own commit to exclude. Otherwise the window opens when
  // another thread first started — and not before this thread's own commit has landed —
  // and without another thread there is nothing to look for.
  let filesFrom: Date | null = sinceAt;
  if (last) {
    const other = await otherThreadStartedAt(input.mind, input.thread, last.at);
    filesFrom = other
      ? new Date(
          Math.max(other.getTime(), last.at.getTime() + OWN_COMMIT_GRACE_MS, sinceAt.getTime()),
        )
      : null;
  }
  if (filesFrom) {
    try {
      const files = await filesSince(input.mind, filesFrom);
      if (files.length > 0) {
        lines.push(
          `files changed: ${files.slice(0, MAX_FILES).join(", ")}${more(files.length - MAX_FILES)}` +
            " — re-read before editing",
        );
      }
    } catch (err) {
      // No repo, a timeout, a git error: the file line is dropped, the rest still goes.
      slog.debug(`could not read file changes for ${input.mind}`, log.errorData(err));
    }
  }

  const header = !last
    ? "[this thread's first turn — in the last hour:"
    : cut
      ? `[since this thread's last turn (ended ${when(last.at, now)}) — the last 24h only:`
      : `[since this thread's last turn (ended ${when(last.at, now)}):`;
  return render(header, lines);
}

function render(header: string, lines: string[]): string | null {
  if (lines.length === 0) return null;
  return `${header}\n${lines.map((l) => `- ${l}`).join("\n")}]`;
}

/**
 * {@link buildSinceNote} for a delivery path: never throws and never takes longer than
 * {@link BUILD_TIMEOUT_MS}. A note that can't be built is omitted — delivery must not stall
 * or fail on it. Returns null for a variant (`target !== mind`): variants record their
 * history under the parent (#652), so their threads' rows are indistinguishable from the
 * parent's and any note would describe the wrong mind.
 */
export async function sinceNoteFor(target: string, input: SinceNoteInput): Promise<string | null> {
  if (target !== input.mind) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      buildSinceNote(input),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => {
          slog.warn(`gave up building the since-last-turn note for ${input.mind} (timeout)`);
          resolve(null);
        }, BUILD_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
  } catch (err) {
    slog.warn(`failed to build the since-last-turn note for ${input.mind}`, log.errorData(err));
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Put the note at the top of a message's content. Content, not a new payload field, for
 * the same reason as the held preface: every template renders content verbatim, and a new
 * field would reach only minds that had upgraded.
 */
export function withSinceNote<T extends { content?: unknown }>(payload: T, note: string | null): T {
  if (!note) return payload;
  const content = payload.content;
  if (typeof content === "string") return { ...payload, content: `${note}\n\n${content}` };
  if (Array.isArray(content)) {
    return { ...payload, content: [{ type: "text", text: note }, ...content] };
  }
  if (content == null) return { ...payload, content: note };
  return { ...payload, content: [{ type: "text", text: note }, content] };
}
