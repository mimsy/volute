/** The label every issue filed from feedback carries, so the spirit can find them again. */
export const LABEL = "mind-feedback";

export type Fetch = typeof fetch;
export type Issue = { number: number; title: string; url: string };

async function call(
  fetchImpl: Fetch,
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const res = await fetchImpl(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "volute-feedback",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json().catch(() => null)) as { message?: string } | null;
  if (!res.ok) throw new Error(`GitHub answered ${res.status}: ${data?.message ?? res.statusText}`);
  return data;
}

export async function createIssue(
  fetchImpl: Fetch,
  token: string,
  repo: string,
  title: string,
  body: string,
): Promise<Issue> {
  const data = (await call(fetchImpl, token, "POST", `/repos/${repo}/issues`, {
    title,
    body,
    labels: [LABEL],
  })) as { number: number; title: string; html_url: string };
  return { number: data.number, title: data.title, url: data.html_url };
}

export async function commentOnIssue(
  fetchImpl: Fetch,
  token: string,
  repo: string,
  number: number,
  body: string,
): Promise<string> {
  const data = (await call(fetchImpl, token, "POST", `/repos/${repo}/issues/${number}/comments`, {
    body,
  })) as { html_url: string };
  return data.html_url;
}

/** Open issues filed from feedback, newest first (pull requests left out). */
export async function listIssues(fetchImpl: Fetch, token: string, repo: string): Promise<Issue[]> {
  const data = (await call(
    fetchImpl,
    token,
    "GET",
    `/repos/${repo}/issues?labels=${LABEL}&state=open&per_page=100`,
  )) as { number: number; title: string; html_url: string; pull_request?: unknown }[];
  return data
    .filter((i) => !i.pull_request)
    .map((i) => ({ number: i.number, title: i.title, url: i.html_url }));
}
