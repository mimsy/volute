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
