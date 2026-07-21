const API_BASE = "/api/ext/intentions";

export interface ApiIntention {
  id: number;
  mind_name: string;
  content: string;
  note: string | null;
  status: "active" | "fulfilled" | "released";
  created_at: string;
  review_at: string;
  last_surfaced_at: string | null;
  resolved_at: string | null;
  resolution_note: string | null;
  // Computed server-side (SQL, against the same UTC clock as the stored timestamps)
  // so the UI never has to parse a DB timestamp itself.
  held_days: number;
  overdue: boolean;
}

export async function fetchBoard(opts?: {
  status?: string;
  mind?: string;
}): Promise<ApiIntention[]> {
  const params = new URLSearchParams();
  if (opts?.status) params.set("status", opts.status);
  if (opts?.mind) params.set("mind", opts.mind);
  const qs = params.toString();
  const res = await fetch(`${API_BASE}${qs ? `?${qs}` : ""}`);
  if (!res.ok) throw new Error("Failed to load intentions");
  return res.json();
}
