import { existsSync, type FSWatcher, readdirSync, statSync, watch } from "node:fs";
import { join, resolve } from "node:path";
import { publish } from "./events/activity-events.js";
import log from "./logger.js";
import { mindDir, readRegistry, voluteHome } from "./registry.js";

type SitePage = { file: string; modified: string; url: string };
type Site = { name: string; label: string; pages: SitePage[] };
type RecentPage = { mind: string; file: string; modified: string; url: string };

const watchers = new Map<string, FSWatcher>();
// Watchers on home/ waiting for pages/ to appear
const homeWatchers = new Map<string, FSWatcher>();
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

// Caches invalidated by file watcher
let sitesCache: Site[] | null = null;
let recentPagesCache: RecentPage[] | null = null;

function startPagesWatcher(mindName: string, pagesDir: string): void {
  try {
    const watcher = watch(pagesDir, { recursive: true }, (_eventType, filename) => {
      if (!filename || !filename.endsWith(".html")) return;

      const key = `${mindName}:${filename}`;
      const existing = debounceTimers.get(key);
      if (existing) clearTimeout(existing);

      debounceTimers.set(
        key,
        setTimeout(() => {
          debounceTimers.delete(key);
          invalidateCache();
          publish({
            type: "page_updated",
            mind: mindName,
            summary: `${mindName} updated ${filename}`,
            metadata: { file: filename },
          }).catch((err) =>
            log.error("failed to publish page_updated activity", log.errorData(err)),
          );
        }, 100),
      );
    });

    watchers.set(mindName, watcher);
  } catch (err) {
    log.warn(`failed to start pages watcher for ${mindName}`, log.errorData(err));
  }
}

export function startWatcher(mindName: string): void {
  if (watchers.has(mindName)) return;

  const pagesDir = resolve(mindDir(mindName), "home", "pages");
  if (existsSync(pagesDir)) {
    startPagesWatcher(mindName, pagesDir);
    return;
  }

  // pages/ doesn't exist yet — watch home/ for its creation
  if (homeWatchers.has(mindName)) return;
  const homeDir = resolve(mindDir(mindName), "home");
  if (!existsSync(homeDir)) return;

  try {
    const hw = watch(homeDir, (_eventType, filename) => {
      if (filename !== "pages") return;
      if (!existsSync(pagesDir)) return;
      // pages/ appeared — stop home watcher, start real pages watcher
      hw.close();
      homeWatchers.delete(mindName);
      invalidateCache();
      startPagesWatcher(mindName, pagesDir);
    });
    homeWatchers.set(mindName, hw);
  } catch (err) {
    log.warn(`failed to start home watcher for ${mindName}`, log.errorData(err));
  }
}

export function stopWatcher(mindName: string): void {
  const watcher = watchers.get(mindName);
  if (watcher) {
    watcher.close();
    watchers.delete(mindName);
  }
  const hw = homeWatchers.get(mindName);
  if (hw) {
    hw.close();
    homeWatchers.delete(mindName);
  }
  // Clear any pending debounce timers
  for (const [key, timer] of debounceTimers) {
    if (key.startsWith(`${mindName}:`)) {
      clearTimeout(timer);
      debounceTimers.delete(key);
    }
  }
}

export function stopAllWatchers(): void {
  for (const [, watcher] of watchers) {
    watcher.close();
  }
  watchers.clear();
  for (const [, hw] of homeWatchers) {
    hw.close();
  }
  homeWatchers.clear();
  for (const [, timer] of debounceTimers) {
    clearTimeout(timer);
  }
  debounceTimers.clear();
  invalidateCache();
}

function invalidateCache(): void {
  sitesCache = null;
  recentPagesCache = null;
}

function scanPagesDir(dir: string, urlPrefix: string): SitePage[] {
  const pages: SitePage[] = [];
  let items: string[];
  try {
    items = readdirSync(dir);
  } catch {
    return pages;
  }

  for (const item of items) {
    if (item.startsWith(".")) continue;
    const fullPath = resolve(dir, item);
    try {
      const s = statSync(fullPath);
      if (s.isFile() && item.endsWith(".html")) {
        pages.push({
          file: item,
          modified: s.mtime.toISOString(),
          url: `${urlPrefix}/${item}`,
        });
      } else if (s.isDirectory()) {
        const indexPath = resolve(fullPath, "index.html");
        if (existsSync(indexPath)) {
          const indexStat = statSync(indexPath);
          pages.push({
            file: join(item, "index.html"),
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

function buildSites(): Site[] {
  const sites: Site[] = [];
  const systemPagesDir = resolve(voluteHome(), "shared", "pages");
  if (existsSync(systemPagesDir)) {
    const systemPages = scanPagesDir(systemPagesDir, "/pages/_system");
    if (systemPages.length > 0) {
      sites.push({ name: "_system", label: "System", pages: systemPages });
    }
  }

  const entries = readRegistry();
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    const pagesDir = resolve(mindDir(entry.name), "home", "pages");
    if (!existsSync(pagesDir)) continue;
    const mindPages = scanPagesDir(pagesDir, `/pages/${entry.name}`);
    if (mindPages.length > 0) {
      sites.push({ name: entry.name, label: entry.name, pages: mindPages });
    }
  }

  return sites;
}

function buildRecentPages(): RecentPage[] {
  const entries = readRegistry();
  const pages: RecentPage[] = [];

  for (const entry of entries) {
    const pagesDir = resolve(mindDir(entry.name), "home", "pages");
    if (!existsSync(pagesDir)) continue;

    let items: string[];
    try {
      items = readdirSync(pagesDir);
    } catch {
      continue;
    }

    for (const item of items) {
      if (item.startsWith(".")) continue;
      const fullPath = resolve(pagesDir, item);
      try {
        const s = statSync(fullPath);
        if (s.isFile() && item.endsWith(".html")) {
          pages.push({
            mind: entry.name,
            file: item,
            modified: s.mtime.toISOString(),
            url: `/pages/${entry.name}/${item}`,
          });
        } else if (s.isDirectory()) {
          const indexPath = resolve(fullPath, "index.html");
          if (existsSync(indexPath)) {
            const indexStat = statSync(indexPath);
            pages.push({
              mind: entry.name,
              file: join(item, "index.html"),
              modified: indexStat.mtime.toISOString(),
              url: `/pages/${entry.name}/${item}/`,
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

export function getCachedSites(): Site[] {
  if (!sitesCache) sitesCache = buildSites();
  return sitesCache;
}

export function getCachedRecentPages(): RecentPage[] {
  if (!recentPagesCache) recentPagesCache = buildRecentPages();
  return recentPagesCache;
}
