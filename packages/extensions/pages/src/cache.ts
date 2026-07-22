import type { Database } from "@volute/extensions";

import { getAllSites, getRecentPages, getSystemPages } from "./db.js";
import { toIso } from "./time.js";

type SitePage = { file: string; modified: string; url: string; author?: string | null };
type Site = { name: string; label: string; pages: SitePage[] };
type RecentPage = {
  mind: string;
  file: string;
  modified: string;
  url: string;
  author?: string | null;
};

function mapFiles(
  mind: string,
  files: { file: string; updated_at: string; author: string | null }[],
): SitePage[] {
  return files.map((f) => ({
    file: f.file,
    // DB timestamps are zone-less UTC; hand the frontend an unambiguous ISO
    // string so `new Date(...)` there can't reinterpret it as local time.
    modified: toIso(f.updated_at),
    url: `/ext/pages/public/${mind}/${f.file}`,
    author: f.author,
  }));
}

export function getSites(db: Database): { sites: Site[]; systemSite: Site | null } {
  const sites = getAllSites(db).map((site) => ({
    name: site.mind,
    label: site.mind,
    pages: mapFiles(site.mind, site.files),
  }));

  const system = getSystemPages(db);
  const systemSite = system
    ? { name: "_system", label: "Shared Pages", pages: mapFiles("_system", system.files) }
    : null;

  return { sites, systemSite };
}

export function getRecentPagesList(
  db: Database,
  opts?: { mind?: string; limit?: number },
): RecentPage[] {
  const rows = getRecentPages(db, opts);
  return rows.map((r) => ({
    mind: r.mind,
    file: r.file,
    modified: toIso(r.updated_at),
    url: `/ext/pages/public/${r.mind}/${r.file}`,
    author: r.author,
  }));
}
