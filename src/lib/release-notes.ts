import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Parse release notes for a specific version from CHANGELOG.md.
 * Returns the content between the version's heading and the next heading, with GitHub links stripped.
 * Returns null if the version isn't found or CHANGELOG.md is missing.
 */
export function parseReleaseNotes(version: string): string | null {
  const changelog = findChangelog();
  if (!changelog) return null;

  const v = version.replace(/^v/, "");

  // Find the heading for this version: ## [VERSION] or ## [VERSION](url)
  const lines = changelog.split("\n");
  let startIdx = -1;
  let endIdx = lines.length;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("## ")) {
      if (startIdx === -1 && line.includes(`[${v}]`)) {
        startIdx = i + 1;
      } else if (startIdx !== -1) {
        endIdx = i;
        break;
      }
    }
  }

  if (startIdx === -1) return null;

  const content = lines.slice(startIdx, endIdx).join("\n").trim();

  if (!content) return null;

  return stripGitHubLinks(content);
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

function findChangelog(): string | null {
  // Walk up from this file to find CHANGELOG.md (same pattern as getCurrentVersion)
  const thisDir = new URL(".", import.meta.url).pathname;
  const candidates = [
    resolve(thisDir, "../CHANGELOG.md"),
    resolve(thisDir, "../../CHANGELOG.md"),
    resolve(thisDir, "../../../CHANGELOG.md"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      try {
        return readFileSync(p, "utf-8");
      } catch {
        return null;
      }
    }
  }
  return null;
}
