import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { readManifest } from "./manifest.js";

type SitePage = { file: string; modified: string; url: string };
type Site = { name: string; label: string; pages: SitePage[] };
type RecentPage = { mind: string; file: string; modified: string; url: string };
type MindEntry = { name: string };

let sitesCache: Site[] | null = null;
let recentPagesCache: RecentPage[] | null = null;

export function invalidateCache(): void {
  sitesCache = null;
  recentPagesCache = null;
}

export function scanPublishedPages(pagesDir: string, urlPrefix: string): SitePage[] {
  const manifest = readManifest(pagesDir);
  const pages: SitePage[] = [];

  let items: string[];
  try {
    items = readdirSync(pagesDir);
  } catch {
    return pages;
  }

  for (const item of items) {
    if (item.startsWith(".") || item === "pages.json") continue;
    const fullPath = resolve(pagesDir, item);
    try {
      const s = statSync(fullPath);
      if (s.isFile() && item.endsWith(".html")) {
        if (!(item in manifest.pages)) continue;
        pages.push({
          file: item,
          modified: s.mtime.toISOString(),
          url: `${urlPrefix}/${item}`,
        });
      } else if (s.isDirectory()) {
        const indexPath = resolve(fullPath, "index.html");
        const indexFile = join(item, "index.html");
        if (existsSync(indexPath) && indexFile in manifest.pages) {
          const indexStat = statSync(indexPath);
          pages.push({
            file: indexFile,
            modified: indexStat.mtime.toISOString(),
            url: `${urlPrefix}/${item}/`,
          });
        }
      }
    } catch {
      // skip unreadable entries
    }
  }

  pages.sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime());
  return pages;
}

export async function buildSites(
  getMindDir: (name: string) => string | null,
  readRegistry: () => Promise<MindEntry[]>,
): Promise<Site[]> {
  const sites: Site[] = [];
  const entries = await readRegistry();

  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    const dir = getMindDir(entry.name);
    if (!dir) continue;
    const pagesDir = resolve(dir, "home", "public", "pages");
    if (!existsSync(pagesDir)) continue;
    const mindPages = scanPublishedPages(pagesDir, `/ext/pages/public/${entry.name}`);
    if (mindPages.length > 0) {
      sites.push({ name: entry.name, label: entry.name, pages: mindPages });
    }
  }

  return sites;
}

export async function buildRecentPages(
  getMindDir: (name: string) => string | null,
  readRegistry: () => Promise<MindEntry[]>,
): Promise<RecentPage[]> {
  const entries = await readRegistry();
  const pages: RecentPage[] = [];

  for (const entry of entries) {
    const dir = getMindDir(entry.name);
    if (!dir) continue;
    const pagesDir = resolve(dir, "home", "public", "pages");
    if (!existsSync(pagesDir)) continue;

    const manifest = readManifest(pagesDir);

    let items: string[];
    try {
      items = readdirSync(pagesDir);
    } catch {
      continue;
    }

    for (const item of items) {
      if (item.startsWith(".") || item === "pages.json") continue;
      const fullPath = resolve(pagesDir, item);
      try {
        const s = statSync(fullPath);
        if (s.isFile() && item.endsWith(".html")) {
          if (!(item in manifest.pages)) continue;
          pages.push({
            mind: entry.name,
            file: item,
            modified: s.mtime.toISOString(),
            url: `/ext/pages/public/${entry.name}/${item}`,
          });
        } else if (s.isDirectory()) {
          const indexPath = resolve(fullPath, "index.html");
          const indexFile = join(item, "index.html");
          if (existsSync(indexPath) && indexFile in manifest.pages) {
            const indexStat = statSync(indexPath);
            pages.push({
              mind: entry.name,
              file: indexFile,
              modified: indexStat.mtime.toISOString(),
              url: `/ext/pages/public/${entry.name}/${item}/`,
            });
          }
        }
      } catch {
        // skip
      }
    }
  }

  pages.sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime());
  return pages.slice(0, 10);
}

export async function getCachedSites(
  getMindDir: (name: string) => string | null,
  readRegistry: () => Promise<MindEntry[]>,
): Promise<Site[]> {
  if (!sitesCache) sitesCache = await buildSites(getMindDir, readRegistry);
  return sitesCache;
}

export async function getCachedRecentPages(
  getMindDir: (name: string) => string | null,
  readRegistry: () => Promise<MindEntry[]>,
): Promise<RecentPage[]> {
  if (!recentPagesCache) recentPagesCache = await buildRecentPages(getMindDir, readRegistry);
  return recentPagesCache;
}
