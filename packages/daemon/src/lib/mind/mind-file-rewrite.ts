import {
  closeSync,
  constants,
  fstatSync,
  ftruncateSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  type Stats,
  writeSync,
} from "node:fs";
import { dirname, sep } from "node:path";
import log from "../util/logger.js";

const wlog = log.child("mind-file-rewrite");

/**
 * Rewrite an existing file inside a mind's directory, in place, from the daemon. `transform`
 * gets the current text and returns the new text, or null to leave the file alone. Returns
 * whether it wrote.
 *
 * The daemon may be root and the file is the mind's, so the write is guarded: it only
 * rewrites an existing file in place (so the inode and its ownership stay the mind's), and
 * refuses when the file's directory resolves outside `dir`, when the file is a symlink or
 * has other hard links, or when the file it opened isn't the one it inspected. That narrows
 * what a mind can aim this write at to its own file; it is not a proof against every race
 * on a directory the mind controls.
 *
 * The write is truncate-then-write on the open fd, not temp-file-and-rename: a rename would
 * put a new, daemon-owned inode in a directory the mind controls. The cost is a brief
 * window in which a concurrent reader can see the file empty or partial.
 */
export function rewriteMindFileInPlace(
  dir: string,
  path: string,
  transform: (text: string) => string | null,
): boolean {
  let inspected: Stats;
  try {
    inspected = lstatSync(path);
  } catch {
    return false;
  }
  // A hard link would let a root write land on a file elsewhere that the mind linked here.
  if (!inspected.isFile() || inspected.nlink !== 1) {
    if (inspected.isFile()) wlog.warn(`${path} has other hard links — not rewriting it`);
    return false;
  }
  if (!realpathSync(dirname(path)).startsWith(realpathSync(dir) + sep)) {
    wlog.warn(`${dirname(path)} resolves outside ${dir} — not rewriting ${path}`);
    return false;
  }

  // O_NOFOLLOW guards only the last path component; the fstat check catches a swap
  // anywhere between the lstat above and this open.
  const fd = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (opened.dev !== inspected.dev || opened.ino !== inspected.ino || opened.nlink !== 1) {
      wlog.warn(`${path} changed while being opened — not rewriting it`);
      return false;
    }
    const out = transform(readFileSync(fd, "utf-8"));
    if (out == null) return false;
    ftruncateSync(fd, 0);
    writeSync(fd, out, 0);
    return true;
  } finally {
    closeSync(fd);
  }
}
