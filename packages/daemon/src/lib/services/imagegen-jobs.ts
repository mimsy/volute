/**
 * Async image-generation jobs. Generation can take minutes (e.g. gpt-image-2),
 * so the mind's `imagegen generate` no longer blocks on it: the daemon runs the
 * job in the background, the skill foregrounds it briefly (long-poll), and on
 * completion the daemon writes the file and wakes the mind with a system event.
 *
 * Jobs live in memory only (like the session/oauth-flow maps) — they do not
 * survive a daemon restart. A `status` check for a lost job 404s, and the skill
 * tells the mind to re-run.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { deliverEvent } from "../chat/system-events.js";
import { chownMindFile } from "../mind/isolation.js";
import { resolveMindDir } from "../mind/registry.js";
import log from "../util/logger.js";
import { safeResolveWithinBase } from "../util/paths.js";
import { generateImage } from "./imagegen.js";

const jobLog = log.child("imagegen-jobs");

/** Most jobs a single mind may have generating at once. */
const MAX_INFLIGHT_PER_MIND = 4;
/** How long a settled job stays queryable via `status` before cleanup. */
const DONE_TTL_MS = 10 * 60 * 1000;
/**
 * Hard ceiling on a single generation. Without it a hung provider connection
 * (e.g. a Codex SSE stream that never closes) would leave the job "running"
 * forever, never freeing its inflight slot or arming TTL cleanup — after
 * MAX_INFLIGHT_PER_MIND hangs the mind could not generate until a daemon restart.
 */
const GENERATION_TIMEOUT_MS = 3 * 60 * 1000;

export type JobStatus = "running" | "done" | "error";

/**
 * Public view of a job (what the API returns). A discriminated union so the
 * status↔payload invariant is compile-time: a `done` job always has `path`, an
 * `error` job always has `error`, and consumers can't read `job.path` without
 * first narrowing to `status: "done"`.
 */
export type ImagegenJob =
  | { status: "running"; id: string; mind: string; createdAt: number }
  | {
      status: "done";
      id: string;
      mind: string;
      createdAt: number;
      completedAt: number;
      path: string;
    }
  | {
      status: "error";
      id: string;
      mind: string;
      createdAt: number;
      completedAt: number;
      error: string;
    };

/**
 * Internal record — kept flat and mutable (the union above would fight the
 * in-place `Object.assign` in `settle`). `publicView` is the single place that
 * projects it into the tight union, enforcing the invariant at that boundary.
 */
type JobRecord = {
  id: string;
  mind: string;
  status: JobStatus;
  path?: string;
  error?: string;
  createdAt: number;
  completedAt?: number;
  /** Resolves when the job leaves "running" (drives the long-poll). */
  settled: Promise<void>;
  resolveSettled: () => void;
  /**
   * Set once a foreground long-poll times out with the job still running — i.e.
   * the job outlived the caller's wait and dropped to the background. Only then
   * does completion fire an "image ready" event; a job that finishes within the
   * foreground wait is already reported to the caller via `saved:`, so a second
   * async notification would just confuse the mind with a duplicate.
   */
  notifyOnDone: boolean;
};

const jobs = new Map<string, JobRecord>();

function publicView(r: JobRecord): ImagegenJob {
  const base = { id: r.id, mind: r.mind, createdAt: r.createdAt };
  if (r.status === "done") {
    if (!r.path) throw new Error(`job ${r.id} is done but has no path`);
    return { ...base, status: "done", completedAt: r.completedAt ?? r.createdAt, path: r.path };
  }
  if (r.status === "error") {
    return {
      ...base,
      status: "error",
      completedAt: r.completedAt ?? r.createdAt,
      error: r.error ?? "unknown error",
    };
  }
  return { ...base, status: "running" };
}

function countInflight(mind: string): number {
  let n = 0;
  for (const r of jobs.values()) if (r.mind === mind && r.status === "running") n++;
  return n;
}

function settle(record: JobRecord, patch: Partial<JobRecord>): void {
  Object.assign(record, patch, { completedAt: Date.now() });
  record.resolveSettled();
  // Keep the settled job briefly for status checks, then drop it. unref so a
  // pending timer never keeps the daemon alive.
  setTimeout(() => jobs.delete(record.id), DONE_TTL_MS).unref?.();
}

/** Injectable side effects (defaults hit the real provider/event bus; tests override). */
export type JobDeps = {
  generate?: (model: string, prompt: string, signal?: AbortSignal) => Promise<Buffer>;
  deliver?: typeof deliverEvent;
};

/** Deliver a job event to the mind, logging (never throwing) if it doesn't land. */
async function notify(deliver: typeof deliverEvent, mind: string, body: string): Promise<void> {
  try {
    const { delivered } = await deliver(mind, {
      type: "imagegen",
      body,
      delivery: "immediate",
      whileSleeping: "queue",
    });
    if (!delivered) jobLog.warn(`imagegen event not delivered to ${mind}: ${body}`);
  } catch (err) {
    jobLog.warn(`failed to deliver imagegen event to ${mind}`, log.errorData(err));
  }
}

async function runJob(
  record: JobRecord,
  model: string,
  prompt: string,
  filename: string,
  deps: JobDeps,
) {
  const generate = deps.generate ?? generateImage;
  const deliver = deps.deliver ?? deliverEvent;
  // Abort a generation that outruns the ceiling so a hung provider connection
  // can't pin the job in "running" forever (see GENERATION_TIMEOUT_MS).
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GENERATION_TIMEOUT_MS);
  timer.unref?.();
  try {
    const buf = await generate(model, prompt, controller.signal);

    const home = `${await resolveMindDir(record.mind)}/home`;
    const target = safeResolveWithinBase(home, `images/${filename}.png`);
    if (!target) throw new Error(`Invalid image filename: ${filename}`);

    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, buf);
    await chownMindFile(target, record.mind);

    settle(record, { status: "done", path: target });

    // Only wake the mind if the job outlived the foreground wait (dropped to
    // background). A job that finished within the wait already returned `saved:`
    // to the caller, so a completion event here would be a confusing duplicate.
    if (record.notifyOnDone) await notify(deliver, record.mind, `image ready: ${target}`);
  } catch (err) {
    const message = controller.signal.aborted
      ? `image generation timed out after ${Math.round(GENERATION_TIMEOUT_MS / 1000)}s`
      : err instanceof Error
        ? err.message
        : String(err);
    jobLog.error(`job ${record.id} failed`, log.errorData(err));
    settle(record, { status: "error", error: message });
    // If the mind was told this dropped to the background, it's waiting for a
    // completion event — tell it the job failed so it doesn't wait forever.
    if (record.notifyOnDone)
      await notify(deliver, record.mind, `image generation failed: ${message}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Start a background generation job. Throws if the mind is already at its
 * in-flight cap. Returns the job id immediately; generation proceeds async.
 */
export function createImagegenJob(
  mind: string,
  model: string,
  prompt: string,
  filename: string,
  deps: JobDeps = {},
): string {
  if (countInflight(mind) >= MAX_INFLIGHT_PER_MIND) {
    throw new Error(
      `Too many image generations in progress (max ${MAX_INFLIGHT_PER_MIND}). Wait for one to finish.`,
    );
  }
  const id = crypto.randomUUID();
  let resolveSettled!: () => void;
  const settled = new Promise<void>((r) => {
    resolveSettled = r;
  });
  const record: JobRecord = {
    id,
    mind,
    status: "running",
    createdAt: Date.now(),
    settled,
    resolveSettled,
    notifyOnDone: false,
  };
  jobs.set(id, record);
  void runJob(record, model, prompt, filename, deps);
  return id;
}

/** Fetch a job, enforcing that it belongs to the requesting mind. */
export function getImagegenJob(mind: string, id: string): ImagegenJob | undefined {
  const record = jobs.get(id);
  if (!record || record.mind !== mind) return undefined;
  return publicView(record);
}

/**
 * Wait up to `timeoutMs` for a job to finish, then return its current state
 * (still "running" on timeout). Returns undefined if the job is unknown or not
 * owned by the mind.
 */
export async function waitForImagegenJob(
  mind: string,
  id: string,
  timeoutMs: number,
): Promise<ImagegenJob | undefined> {
  const record = jobs.get(id);
  if (!record || record.mind !== mind) return undefined;
  if (record.status === "running" && timeoutMs > 0) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((r) => {
      timer = setTimeout(r, timeoutMs);
      timer.unref?.();
    });
    await Promise.race([record.settled, timeout]);
    if (timer) clearTimeout(timer);
    // Still running after the wait → the job is going to the background, so its
    // eventual completion should notify the mind (see JobRecord.notifyOnDone).
    if (record.status === "running") record.notifyOnDone = true;
  }
  return publicView(record);
}

/** Test seam: drop all jobs. */
export function _resetImagegenJobs(): void {
  jobs.clear();
}
