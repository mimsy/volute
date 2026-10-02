import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isNewer } from "./update-check.js";
import { voluteManifest } from "./util/volute-root.js";

export type ReleaseNotesSection = { version: string; notes: string };

/** At most this many sections, or this many characters, go into one notice (#1350). */
const MAX_SECTIONS = 5;
const MAX_CHARS = 6000;

/**
 * Parse release notes for a specific version from CHANGELOG.md.
 * Returns the content between the version's heading and the next heading, with GitHub links stripped.
 * Returns null if the version isn't found or CHANGELOG.md is missing.
 */
export function parseReleaseNotes(
  version: string,
  changelog: string | null = findChangelog(),
): string | null {
  const v = version.replace(/^v/, "");
  return parseSections(changelog).find((s) => s.version === v)?.notes ?? null;
}

/**
 * Every CHANGELOG section newer than `from`, up to and including `to`, newest first —
 * what a mind last told about `from` has missed. When either version can't be parsed,
 * or `from` isn't older than `to`, this is just `to`'s section (if it has one).
 */
export function parseReleaseNotesSince(
  from: string,
  to: string,
  changelog: string | null = findChangelog(),
): ReleaseNotesSection[] {
  const f = from.replace(/^v/, "");
  const t = to.replace(/^v/, "");
  const sections = parseSections(changelog);
  if (!isVersion(f) || !isVersion(t) || !isNewer(f, t)) {
    return sections.filter((s) => s.version === t);
  }
  return sections
    .filter((s) => isVersion(s.version) && isNewer(f, s.version) && !isNewer(t, s.version))
    .sort((a, b) => (isNewer(a.version, b.version) ? 1 : isNewer(b.version, a.version) ? -1 : 0));
}

/**
 * Render sections for a notice. A single section is its notes alone, as before #1350;
 * several are each headed by their version, capped at {@link MAX_SECTIONS} sections or
 * {@link MAX_CHARS} characters (the newest is always kept whole), with one line naming
 * what was left out.
 */
export function formatReleaseNotes(sections: ReleaseNotesSection[], from: string): string | null {
  if (sections.length === 0) return null;
  if (sections.length === 1) return sections[0].notes;

  const parts: string[] = [];
  let length = 0;
  for (const s of sections) {
    const part = `## v${s.version}\n\n${s.notes}`;
    if (parts.length === MAX_SECTIONS) break;
    if (parts.length > 0 && length + part.length > MAX_CHARS) break;
    parts.push(part);
    length += part.length + 2;
  }
  const rest = sections.length - parts.length;
  if (rest > 0) {
    const since = `v${from.replace(/^v/, "")}`;
    parts.push(
      `…and ${rest} earlier ${rest === 1 ? "release" : "releases"} since ${since}; see CHANGELOG.md in the Volute install`,
    );
  }
  return parts.join("\n\n");
}

function isVersion(v: string): boolean {
  return /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(v);
}

/** Every version section of a CHANGELOG, in file order, with GitHub links stripped. */
function parseSections(changelog: string | null): ReleaseNotesSection[] {
  if (!changelog) return [];
  const sections: ReleaseNotesSection[] = [];
  let current: { version: string; lines: string[] } | null = null;
  const flush = () => {
    const content = current?.lines.join("\n").trim();
    if (current && content) {
      sections.push({ version: current.version, notes: stripGitHubLinks(content) });
    }
  };
  for (const line of changelog.split("\n")) {
    if (line.startsWith("## ")) {
      flush();
      // ## [VERSION] or ## [VERSION](url)
      const version = line.match(/^## \[v?([^\]]+)\]/)?.[1];
      current = version ? { version, lines: [] } : null;
    } else {
      current?.lines.push(line);
    }
  }
  flush();
  return sections;
}

/**
 * Strip GitHub PR/commit links from changelog entries.
 * Transforms: `* feature ([#123](url)) ([abc123](url))` → `* feature`
 */
function stripGitHubLinks(text: string): string {
  return text
    .replace(/ \(\[#\d+\]\([^)]*\)\)/g, "")
    .replace(/ \(\[[a-f0-9]+\]\([^)]*\)\)/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

let changelogOverride: string | undefined;

/** Test-only: read this text as the CHANGELOG instead of the install's (undefined restores it). */
export function setChangelogForTesting(text: string | undefined): void {
  changelogOverride = text;
}

function findChangelog(): string | null {
  if (changelogOverride !== undefined) return changelogOverride;
  const manifest = voluteManifest();
  if (!manifest) return null;
  try {
    return readFileSync(resolve(manifest.root, "CHANGELOG.md"), "utf-8");
  } catch {
    return null;
  }
}
