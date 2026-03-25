const API_BASE = "/api/ext/pages";

export interface SitePage {
  file: string;
  modified: string;
  url: string;
  author?: string | null;
}

export interface Site {
  name: string;
  label: string;
  pages: SitePage[];
}

export interface RecentPage {
  mind: string;
  file: string;
  modified: string;
  url: string;
  author?: string | null;
}

export async function fetchPagesData(): Promise<{
  sites: Site[];
  systemSite: Site | null;
  recentPages: RecentPage[];
}> {
  const res = await fetch(API_BASE);
  if (!res.ok) {
    console.warn(`Failed to fetch pages data: HTTP ${res.status}`);
    return { sites: [], systemSite: null, recentPages: [] };
  }
  return res.json();
}
