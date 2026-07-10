import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isImagegenEnabled } from "../config/setup.js";
import { MEMORY_PLACEHOLDER_MARKER, ORIENTATION_MARKER } from "../prompts.js";
import { safeResolveWithinBase } from "../util/paths.js";
import { readVoluteConfig } from "./volute-config.js";

/**
 * The seed → sprout checklist, evaluated from a mind's files and config.
 *
 * Single source of truth for the sprout gate (`volute seed sprout`), the
 * spirit-facing readiness check (`GET /:name/seed-check`), and the orientation
 * checklist. Keeping the predicates here — rather than duplicated at each call
 * site — is what makes those three actually agree.
 */
export type SeedChecklist = {
  soulWritten: boolean;
  memoryWritten: boolean;
  displayNameSet: boolean;
  /** True only when a profile avatar is set AND its file exists on disk. */
  avatarSet: boolean;
  imagegenEnabled: boolean;
};

/** SOUL.md counts as written once it no longer contains the orientation marker. */
export function isSoulWritten(text: string): boolean {
  return !text.includes(ORIENTATION_MARKER);
}

/** MEMORY.md counts as written only if it's non-empty and not the starter placeholder. */
export function isMemoryWritten(text: string): boolean {
  return text.trim().length > 0 && !text.includes(MEMORY_PLACEHOLDER_MARKER);
}

export function evaluateSeedChecklist(dir: string): SeedChecklist {
  const soulPath = resolve(dir, "home/SOUL.md");
  const memoryPath = resolve(dir, "home/MEMORY.md");

  const soulWritten = existsSync(soulPath) && isSoulWritten(readFileSync(soulPath, "utf-8"));
  const memoryWritten =
    existsSync(memoryPath) && isMemoryWritten(readFileSync(memoryPath, "utf-8"));

  const config = readVoluteConfig(dir);
  const displayNameSet = !!config?.profile?.displayName;

  // profile.avatar is mind-controllable — contain it before touching the fs.
  const avatarPath = config?.profile?.avatar;
  const resolvedAvatar = avatarPath
    ? safeResolveWithinBase(resolve(dir, "home"), avatarPath)
    : null;
  const avatarSet = !!resolvedAvatar && existsSync(resolvedAvatar);

  return {
    soulWritten,
    memoryWritten,
    displayNameSet,
    avatarSet,
    imagegenEnabled: isImagegenEnabled(),
  };
}
