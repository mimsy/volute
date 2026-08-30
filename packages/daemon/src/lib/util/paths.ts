import { realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";

/**
 * Thrown when a user-supplied path resolves outside its intended base directory.
 */
export class PathTraversalError extends Error {
  constructor(base: string, userPath: string) {
    super(`Path "${userPath}" escapes base directory "${base}"`);
    this.name = "PathTraversalError";
  }
}

/**
 * Resolve `userPath` against `base` and guarantee the result stays within `base`.
 *
 * Use this for ANY filesystem operation (read/write/delete) whose path includes
 * an attacker-controllable segment — mind names, filenames, config values, etc.
 * Absolute paths and `..` traversal that escape `base` throw PathTraversalError
 * rather than silently resolving outside the intended directory.
 *
 * @returns the absolute, contained path.
 * @throws PathTraversalError if the resolved path is outside `base`.
 */
export function resolveWithinBase(base: string, userPath: string): string {
  const resolvedBase = resolve(base);
  const target = resolve(resolvedBase, userPath);
  if (target !== resolvedBase && !target.startsWith(resolvedBase + sep)) {
    throw new PathTraversalError(base, userPath);
  }
  return target;
}

/**
 * Non-throwing variant of {@link resolveWithinBase}. Returns the contained
 * absolute path, or `null` if `userPath` would escape `base`.
 */
export function safeResolveWithinBase(base: string, userPath: string): string | null {
  try {
    return resolveWithinBase(base, userPath);
  } catch {
    return null;
  }
}

/**
 * Symlink-aware variant of {@link resolveWithinBase}: the *real* path must stay
 * within the *real* base, so a symlink planted inside `base` cannot point out of
 * it. Use this for paths that must already exist — reads, and serving files.
 *
 * For a path that does not exist yet (anything about to be created), use
 * {@link resolveWithinBase}: `realpath` throws ENOENT on a missing path.
 *
 * Filesystem errors are deliberately not swallowed — callers distinguish "escapes
 * the base" (PathTraversalError) from "isn't there" (ENOENT) from everything else.
 *
 * @returns the absolute, symlink-resolved, contained path.
 * @throws PathTraversalError if the path — before or after symlink resolution —
 *   is outside `base`.
 * @throws NodeJS.ErrnoException from `realpath` if `base` or the target is
 *   missing or unreadable.
 */
export async function resolveRealWithinBase(base: string, userPath: string): Promise<string> {
  const target = resolveWithinBase(base, userPath);
  const realBase = await realpath(base);
  const realTarget = await realpath(target);
  if (realTarget !== realBase && !realTarget.startsWith(realBase + sep)) {
    throw new PathTraversalError(base, userPath);
  }
  return realTarget;
}
