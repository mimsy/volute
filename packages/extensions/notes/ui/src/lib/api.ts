const API_BASE = "/api/ext/notes";

export interface ApiNote {
  id: number;
  title: string;
  author_username: string;
  slug: string;
  content: string;
  comment_count: number;
  created_at: string;
  updated_at: string;
  reply_to?: { author_username: string; slug: string; title: string } | null;
  reactions?: { emoji: string; count: number; usernames: string[] }[];
  comments?: ApiComment[];
  replies?: ApiReply[];
  author_display_name?: string | null;
}

export interface ApiComment {
  id: number;
  author_username: string;
  author_display_name: string | null;
  content: string;
  created_at: string;
}

export interface ApiReply {
  author_username: string;
  slug: string;
  title: string;
  created_at: string;
}

export async function fetchNotes(opts?: {
  author?: string;
  limit?: number;
  offset?: number;
}): Promise<ApiNote[]> {
  const params = new URLSearchParams();
  if (opts?.author) params.set("author", opts.author);
  if (opts?.limit) params.set("limit", String(opts.limit));
  if (opts?.offset) params.set("offset", String(opts.offset));
  const qs = params.toString();
  const res = await fetch(`${API_BASE}${qs ? `?${qs}` : ""}`);
  if (!res.ok) throw new Error("Failed to load notes");
  return res.json();
}

export async function fetchNote(author: string, slug: string): Promise<ApiNote | null> {
  const res = await fetch(`${API_BASE}/${encodeURIComponent(author)}/${encodeURIComponent(slug)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Failed to load note (${res.status})`);
  return res.json();
}

export async function createNote(title: string, content: string): Promise<ApiNote> {
  const res = await fetch(API_BASE, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, content }),
  });
  if (!res.ok) throw new Error("Failed to create note");
  return res.json();
}

export async function addComment(author: string, slug: string, content: string): Promise<void> {
  const res = await fetch(
    `${API_BASE}/${encodeURIComponent(author)}/${encodeURIComponent(slug)}/comments`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    },
  );
  if (!res.ok) throw new Error(`Failed to add comment (${res.status})`);
}

export async function deleteComment(
  author: string,
  slug: string,
  commentId: number,
): Promise<void> {
  const res = await fetch(
    `${API_BASE}/${encodeURIComponent(author)}/${encodeURIComponent(slug)}/comments/${commentId}`,
    { method: "DELETE" },
  );
  if (!res.ok) throw new Error(`Failed to delete comment (${res.status})`);
}

export async function toggleReaction(author: string, slug: string, emoji: string): Promise<void> {
  const res = await fetch(
    `${API_BASE}/${encodeURIComponent(author)}/${encodeURIComponent(slug)}/reactions`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ emoji }),
    },
  );
  if (!res.ok) throw new Error("Failed to toggle reaction");
}

export interface CurrentUser {
  username: string;
  avatarUrl: string | null;
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
