import { constants } from "node:fs";
import { type FileHandle, lstat, mkdir, open, realpath, rm } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import log from "../util/logger.js";
import { PathTraversalError, resolveWithinBase } from "../util/paths.js";
import { chownNoFollow, containMindPath } from "./isolation.js";

const wlog = log.child("mind-file-write");

export type MindFileOwner = { uid: number; gid: number };

/** Largest file the daemon will read back from a mind (auth.json, routes.json, a doc). */
const MAX_READ_BYTES = 1024 * 1024;

/*
 * Reading and writing a mind's files from the daemon, which is root under user isolation,
 * in a tree the mind owns and can rearrange at will. Every access takes the same three
 * steps, so nothing a mind plants can aim the daemon elsewhere:
 *
 * 1. Anchor. With an `owner`, the mind dir's real path must stay inside the topmost
 *    directory that owner owns (`containMindPath`): a variant lives in its parent's
 *    `.variants/`, which the parent can swap for a link into another mind's tree. Without
 *    one (isolation off) the daemon runs as the minds' own user, and the anchor is the
 *    mind dir's real path.
 * 2. Walk. Each directory from the mind dir down to the file's parent is resolved and must
 *    stay inside the anchor — `ln -s /etc home/images` refuses. A missing one is created
 *    (non-recursively, so never through a link) and handed to `owner` at once.
 * 3. Open. The file is opened `O_NOFOLLOW` (a link at the name refuses) and `O_NONBLOCK` (a
 *    FIFO can't hang the daemon), then fstat'd: anything but a regular file with a single
 *    link — a FIFO, a hard link to a file elsewhere — refuses before it is read or
 *    truncated. Reads, writes and the chown all go through that one handle.
 *
 * What stays open is a race: a directory swapped for a link between its resolve and the
 * open, which needs an openat-style walk Node does not offer.
 */

/**
 * Step 1: the real path everything must stay inside. `containMindPath` answers with the
 * lexical path when no ancestor is the owner's (a dir not handed over yet), so realpath
 * it either way — the walk compares real paths, and a mind dir reached through a linked
 * prefix (`/var` -> `/private/var`, a host's `/minds` -> `/data/minds`) must still match.
 */
export async function mindAnchor(mindDir: string, owner: MindFileOwner | null): Promise<string> {
  return realpath(owner ? await containMindPath(mindDir, (st) => st.uid === owner.uid) : mindDir);
}

/** Step 2: resolve `rel`'s directories under the mind dir, creating missing ones. */
async function walkDirs(
  mindDir: string,
  rel: string,
  owner: MindFileOwner | null,
  create: boolean,
): Promise<string | null> {
  const anchor = await mindAnchor(mindDir, owner);
  let dir = anchor;
  for (const part of rel.split(sep).filter(Boolean)) {
    const next = join(dir, part);
    let real: string | null = await realpathOrNull(next);
    if (real === null) {
      if (!create) return null;
      try {
        // Non-recursive, so never through a link.
        await mkdir(next);
        if (owner) await chownNoFollow(next, owner.uid, owner.gid, "dir");
        dir = next;
        continue;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        // Someone got there first — another writer, or the mind. Judge what they made
        // like anything else found on the way; a dangling link still resolves to nothing.
        real = await realpathOrNull(next);
        if (real === null) throw new Error(`refusing ${next}: a link to nothing`);
      }
    }
    if (!real.startsWith(anchor + sep)) throw new PathTraversalError(mindDir, rel);
    dir = real;
  }
  return dir;
}

async function realpathOrNull(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** Steps 1 and 2 for a file: its real path, or null if a directory on the way is absent. */
async function containedPath(
  mindDir: string,
  relPath: string,
  owner: MindFileOwner | null,
  create: boolean,
): Promise<string | null> {
  const target = resolveWithinBase(mindDir, relPath);
  const dir = await walkDirs(mindDir, relative(resolve(mindDir), dirname(target)), owner, create);
  return dir === null ? null : join(dir, basename(target));
}

/**
 * Create (if missing) the directory `relPath` inside a mind's directory, through the same
 * anchor and walk as {@link writeMindFile}, and return its real path — the one to act on.
 */
export async function ensureMindDir(
  mindDir: string,
  relPath: string,
  owner: MindFileOwner | null,
): Promise<string> {
  const target = resolveWithinBase(mindDir, relPath);
  const dir = await walkDirs(mindDir, relative(resolve(mindDir), target), owner, true);
  if (dir === null) throw new Error(`could not create ${target}`);
  return dir;
}

/** Step 3. Null when the file is absent (without O_CREAT) or present (with O_EXCL). */
async function openVetted(path: string, flags: number, mode: number): Promise<FileHandle | null> {
  const { O_CREAT, O_EXCL, O_NOFOLLOW, O_NONBLOCK } = constants;
  let handle: FileHandle;
  try {
    handle = await open(path, flags | O_NOFOLLOW | O_NONBLOCK, mode);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" && !(flags & O_CREAT)) return null;
    if (code === "EEXIST" && flags & O_EXCL) return null;
    // ELOOP: a symlink at the name. ENXIO: a FIFO opened write-only with no reader.
    if (code === "ELOOP" || code === "ENXIO") {
      throw new Error(`refusing ${path}: not a regular file (${code})`);
    }
    throw err;
  }
  const st = await handle.stat();
  if (!st.isFile() || st.nlink !== 1) {
    await handle.close();
    throw new Error(`refusing ${path}: not a regular file with a single link`);
  }
  return handle;
}

/** Read at most the cap — by bytes actually read, not a size taken before reading. */
async function readCapped(handle: FileHandle, path: string): Promise<string> {
  const buf = Buffer.alloc(MAX_READ_BYTES + 1);
  let len = 0;
  while (len < buf.length) {
    const { bytesRead } = await handle.read(buf, len, buf.length - len, len);
    if (bytesRead === 0) break;
    len += bytesRead;
  }
  if (len > MAX_READ_BYTES) {
    throw new Error(`refusing to read ${path}: larger than ${MAX_READ_BYTES} bytes`);
  }
  return buf.toString("utf-8", 0, len);
}

/**
 * One file access at a time per real path, in this process: a read-modify-write (pi
 * auth.json, from a restart and the refresh fan-out at once) interleaved with another
 * would lose one's change or leave the two spliced into invalid JSON.
 */
const pathQueues = new Map<string, Promise<unknown>>();

async function serialized<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const run = (pathQueues.get(path) ?? Promise.resolve()).then(fn, fn);
  const tail = run.catch(() => {});
  pathQueues.set(path, tail);
  try {
    return await run;
  } finally {
    if (pathQueues.get(path) === tail) pathQueues.delete(path);
  }
}

/**
 * Write a file into a mind's directory (see the steps above). `content` is the bytes to
 * write, or a function of the file's current text ("" when new) that returns them, or
 * null to leave the file alone — only that form reads the file. `create`:
 * - true (default): create or replace.
 * - "if-absent": create only; a file already there is the mind's and is left alone.
 * - false: rewrite an existing file only; an absent one is left alone.
 *
 * Replaces in place — truncate and write the open handle — not temp-file-and-rename, so the
 * inode (which the Agent SDK watches for credential reloads) survives. `owner` is set on
 * the handle as soon as it is open; null when isolation is off. A file this call created
 * is removed again if nothing ends up written to it (null from `content`, or a throw).
 * Returns whether it wrote.
 */
export async function writeMindFile(
  mindDir: string,
  relPath: string,
  content: string | Buffer | ((current: string) => string | Buffer | null),
  opts: { owner: MindFileOwner | null; mode?: number; create?: boolean | "if-absent" },
): Promise<boolean> {
  const create = opts.create ?? true;
  const path = await containedPath(mindDir, relPath, opts.owner, create !== false);
  if (!path) return false;
  const { O_RDWR, O_WRONLY, O_CREAT, O_EXCL } = constants;
  const transform = typeof content === "function" ? content : null;
  const access = transform ? O_RDWR : O_WRONLY;
  const mode = opts.mode ?? 0o644;
  return serialized(path, async () => {
    // Create exclusively first, so we know whether the file is new: a new one is handed to
    // the owner before anything can fail, and removed again if nothing is written to it.
    let handle = create ? await openVetted(path, access | O_CREAT | O_EXCL, mode) : null;
    const created = handle !== null;
    if (!handle && create !== "if-absent") handle = await openVetted(path, access, mode);
    if (!handle) return false;
    let wrote = false;
    try {
      if (opts.owner) await handle.chown(opts.owner.uid, opts.owner.gid);
      const data = transform ? transform(await readCapped(handle, path)) : content;
      if (data == null) return false;
      await handle.truncate(0);
      const buf = typeof data === "string" ? Buffer.from(data) : (data as Buffer);
      for (let off = 0; off < buf.length; ) {
        off += (await handle.write(buf, off, buf.length - off, off)).bytesWritten;
      }
      wrote = true;
      return true;
    } finally {
      await handle.close();
      // A file this call created and never finished writing is not left behind empty.
      if (created && !wrote) await rm(path, { force: true });
    }
  });
}

/**
 * Read a file in a mind's directory through the same anchor, walk and vetted open as
 * {@link writeMindFile}. Returns its real path and text, or null when it is absent.
 * Throws on a refusal (a link, a FIFO, a file too large).
 */
export async function readMindFile(
  mindDir: string,
  relPath: string,
  opts: { owner: MindFileOwner | null },
): Promise<{ path: string; text: string } | null> {
  const path = await containedPath(mindDir, relPath, opts.owner, false);
  if (!path) return null;
  return serialized(path, async () => {
    const handle = await openVetted(path, constants.O_RDONLY, 0);
    if (!handle) return null;
    try {
      return { path, text: await readCapped(handle, path) };
    } finally {
      await handle.close();
    }
  });
}

/**
 * Remove a regular file in a mind's directory, re-contained just before the unlink. The
 * unlink itself is by path — Node has no unlinkat — so a directory swapped for a link
 * between the check and the rm is the same narrow race the module header names.
 */
export async function removeMindFile(
  mindDir: string,
  relPath: string,
  opts: { owner: MindFileOwner | null },
): Promise<void> {
  const path = await containedPath(mindDir, relPath, opts.owner, false);
  if (!path) return;
  await serialized(path, async () => {
    const st = await lstat(path).catch(() => null);
    if (st?.isFile()) await rm(path, { force: true });
  });
}

/**
 * Rewrite an existing file inside a mind's directory in place: {@link writeMindFile} with
 * `create: false`, so the inode stays the mind's. For migrations on upgrade paths, which
 * must not fail over one file: a refusal is logged and reported as not written.
 * `transform` returns null to leave the file alone. Pass the mind's `owner` under
 * isolation — it is what anchors a variant's dir to its parent's tree.
 */
export async function rewriteMindFileInPlace(
  dir: string,
  path: string,
  transform: (text: string) => string | null,
  owner: MindFileOwner | null = null,
): Promise<boolean> {
  try {
    return await writeMindFile(dir, relative(dir, path), transform, { owner, create: false });
  } catch (err) {
    wlog.warn(`not rewriting ${path}`, log.errorData(err));
    return false;
  }
}
