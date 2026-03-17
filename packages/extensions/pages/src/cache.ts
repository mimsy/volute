import type { Database } from "@volute/extensions";

import { getAllSites, getRecentPages } from "./db.js";

type SitePage = { file: string; modified: string; url: string };
type Site = { name: string; label: string; pages: SitePage[] };
type RecentPage = { mind: string; file: string; modified: string; url: string };

export function getSites(db: Database): Site[] {
  const sites = getAllSites(db);
  return sites.map((site) => ({
    name: site.mind,
    label: site.mind,
    pages: site.files.map((f) => ({
      file: f.file,
      modified: f.updated_at,
      url: `/ext/pages/public/${site.mind}/${f.file}`,
    })),
  }));
}

export function getRecentPagesList(
  db: Database,
  opts?: { mind?: string; limit?: number },
): RecentPage[] {
  const rows = getRecentPages(db, opts);
  return rows.map((r) => ({
    mind: r.mind,
    file: r.file,
    modified: r.updated_at,
    url: `/ext/pages/public/${r.mind}/${r.file}`,
  }));
}
