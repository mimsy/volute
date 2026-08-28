export type {
  ActivityEvent,
  ArgDef,
  CommandHandler,
  Database,
  ExtensionCommand,
  ExtensionContext,
  ExtensionFeedItem,
  ExtensionManifest,
  FeedSource,
  FlagDef,
  MindSection,
  SystemSection,
  TurnContextOptions,
  TurnContextProvider,
  TurnContextReason,
  User,
} from "./types.js";

import type { ExtensionManifest } from "./types.js";

const VALID_EXTENSION_ID = /^[a-z0-9][a-z0-9_-]*$/;

export function createExtension(manifest: ExtensionManifest): ExtensionManifest {
  if (!manifest.id) throw new Error("Extension manifest requires an id");
  if (!VALID_EXTENSION_ID.test(manifest.id))
    throw new Error(
      "Extension id must be lowercase alphanumeric with hyphens/underscores, starting with a letter or digit",
    );
  if (typeof manifest.routes !== "function")
    throw new Error("Extension manifest requires a routes function");
  return manifest;
}

/**
 * Parse a bounded integer query param: `fallback` when absent, `null` when malformed or
 * below `min` (the caller should 400), clamped down to `max` otherwise.
 *
 * Mirrors `boundedIntParam` in packages/daemon/src/lib/util/query-params.ts — extensions
 * deliberately don't import daemon internals (see the same note on pages' `time.ts`), so
 * this is the copy they share rather than one apiece.
 *
 * `parseInt` is what this exists to replace. It salvages a leading numeric prefix, so
 * `?limit=1e9` becomes 1 and serves a single row, and `parseInt("notanumber")` is NaN, so
 * the customary `|| 8` restores the default and calls it an answer. Both return 200 with
 * real content and nothing to tell the caller their bound was never honoured.
 */
export function boundedIntParam(
  raw: string | undefined,
  { fallback, min, max }: { fallback: number; min: number; max: number },
): number | null {
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < min) return null;
  return Math.min(n, max);
}

/**
 * The refusal text for a `boundedIntParam` that returned null, naming the range.
 *
 * Mirrors `intParamError` in packages/daemon/src/lib/util/query-params.ts. "must be a
 * non-negative integer" is false for the case that most often triggers it: `?limit=0` is
 * a non-negative integer and is refused anyway. A refusal that doesn't say what would be
 * accepted is only half a signal.
 */
export function intParamError(name: string, { min, max }: { min: number; max: number }): string {
  return `${name} must be an integer between ${min} and ${max}`;
}
