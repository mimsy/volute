const API_BASE = "/api/ext/pages";

export interface SitePage {
  file: string;
  modified: string;
  url: string;
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
}

export async function fetchPagesData(): Promise<{
  sites: Site[];
  recentPages: RecentPage[];
}> {
  const res = await fetch(API_BASE);
  if (!res.ok) {
    console.warn(`Failed to fetch pages data: HTTP ${res.status}`);
    return { sites: [], recentPages: [] };
  }
  return res.json();
}
