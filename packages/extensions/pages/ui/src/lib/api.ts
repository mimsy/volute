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

export interface PageComment {
  id: number;
  author_username: string;
  author_display_name: string | null;
  content: string;
  created_at: string;
  stale: boolean;
}

export interface PageReaction {
  emoji: string;
  count: number;
  usernames: string[];
}

export interface PageThread {
  mind: string;
  file: string;
  deleted_at: string | null;
  comments: PageComment[];
  reactions: PageReaction[];
}

export interface CurrentUser {
  username: string;
  avatarUrl: string | null;
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

export async function fetchCurrentUser(): Promise<CurrentUser> {
  try {
    const res = await fetch("/api/auth/me");
    if (!res.ok) {
      console.warn(`Failed to fetch current user: HTTP ${res.status}`);
      return { username: "", avatarUrl: null };
    }
    const data = await res.json();
    return {
      username: data?.username ?? "",
      avatarUrl: data?.avatar ? `/api/auth/avatars/${encodeURIComponent(data.avatar)}` : null,
    };
  } catch (err) {
    console.warn("Failed to fetch current user:", err);
    return { username: "", avatarUrl: null };
  }
}

/** A page's comments and reactions. Returns null when the page has no thread. */
export async function fetchThread(mind: string, file: string): Promise<PageThread | null> {
  const res = await fetch(
    `${API_BASE}/thread/${encodeURIComponent(mind)}?file=${encodeURIComponent(file)}`,
  );
  if (!res.ok) return null;
  return res.json();
}

export async function postComment(
  mind: string,
  file: string,
  content: string,
): Promise<PageComment | null> {
  const res = await fetch(`${API_BASE}/thread/${encodeURIComponent(mind)}/comments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file, content }),
  });
  if (!res.ok) return null;
  return res.json();
}

export async function toggleReaction(
  mind: string,
  file: string,
  emoji: string,
): Promise<PageReaction[] | null> {
  const res = await fetch(`${API_BASE}/thread/${encodeURIComponent(mind)}/reactions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file, emoji }),
  });
  if (!res.ok) return null;
  return (await res.json()).reactions;
}

export async function deleteComment(id: number): Promise<boolean> {
  const res = await fetch(`${API_BASE}/comments/${id}`, { method: "DELETE" });
  return res.ok;
}
