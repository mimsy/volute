const API_BASE = "/api/ext/plan";

export interface ApiPlan {
  id: number;
  title: string;
  description: string;
  status: string;
  set_by_username: string;
  set_by_display_name: string | null;
  created_at: string;
  completed_at: string | null;
  logs?: ApiPlanLog[];
}

export interface ApiPlanLog {
  id: number;
  plan_id: number;
  mind_name: string;
  content: string;
  created_at: string;
}

export async function fetchCurrentPlan(): Promise<ApiPlan | null> {
  const res = await fetch(`${API_BASE}/current`);
  if (!res.ok) throw new Error("Failed to load current plan");
  const data = await res.json();
  return data ?? null;
}

export async function fetchPlans(opts?: {
  status?: string;
  limit?: number;
  offset?: number;
}): Promise<ApiPlan[]> {
  const params = new URLSearchParams();
  if (opts?.status) params.set("status", opts.status);
  if (opts?.limit) params.set("limit", String(opts.limit));
  if (opts?.offset) params.set("offset", String(opts.offset));
  const qs = params.toString();
  const res = await fetch(`${API_BASE}${qs ? `?${qs}` : ""}`);
  if (!res.ok) throw new Error("Failed to load plans");
  return res.json();
}
