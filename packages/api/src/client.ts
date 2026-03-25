// Configurable HTTP client for the Volute API.
// Used by the web UI, CLI, Electron, and third-party apps.

export type ClientOptions = {
  /** Base URL for all API requests (e.g., "https://mybox:1618"). Empty string for same-origin. */
  baseUrl?: string;
  /** Bearer token for authentication. When set, sent as Authorization header. */
  token?: string;
  /** Custom fetch implementation (for Node.js or testing). Defaults to globalThis.fetch. */
  fetch?: typeof globalThis.fetch;
};

export type VoluteClient = {
  /** GET request, returns parsed JSON */
  get: <T>(path: string) => Promise<T>;
  /** POST request with optional JSON body, returns parsed JSON */
  post: <T>(path: string, body?: unknown) => Promise<T>;
  /** PUT request with optional JSON body */
  put: (path: string, body?: unknown) => Promise<void>;
  /** PATCH request with optional JSON body, returns parsed JSON */
  patch: <T>(path: string, body?: unknown) => Promise<T>;
  /** DELETE request */
  del: (path: string) => Promise<void>;
  /** Raw fetch with auth headers applied */
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
  /** The resolved base URL */
  baseUrl: string;
  /** Update the auth token */
  setToken: (token: string | null) => void;
};

/**
 * Create a Volute API client with configurable base URL and authentication.
 *
 * In local mode (default): baseUrl is empty, uses same-origin relative paths.
 * In remote mode: baseUrl points at the daemon, Bearer token is injected.
 */
export function createClient(opts: ClientOptions = {}): VoluteClient {
  const baseUrl = (opts.baseUrl ?? "").replace(/\/$/, "");
  let token = opts.token ?? null;
  const doFetch = opts.fetch ?? globalThis.fetch.bind(globalThis);

  function applyAuth(headers: Headers): void {
    if (token) {
      headers.set("Authorization", `Bearer ${token}`);
    }
  }

  async function request(path: string, init?: RequestInit): Promise<Response> {
    const headers = new Headers(init?.headers);
    applyAuth(headers);
    return doFetch(`${baseUrl}${path}`, { ...init, headers });
  }

  async function get<T>(path: string): Promise<T> {
    const res = await request(path);
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(data.error || `Request failed: ${res.status}`);
    }
    return res.json() as Promise<T>;
  }

  async function post<T>(path: string, body?: unknown): Promise<T> {
    const res = await request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body != null ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(data.error || `Request failed: ${res.status}`);
    }
    return res.json() as Promise<T>;
  }

  async function put(path: string, body?: unknown): Promise<void> {
    const res = await request(path, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: body != null ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(data.error || `Request failed: ${res.status}`);
    }
  }

  async function patch<T>(path: string, body?: unknown): Promise<T> {
    const res = await request(path, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: body != null ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(data.error || `Request failed: ${res.status}`);
    }
    return res.json() as Promise<T>;
  }

  async function del(path: string): Promise<void> {
    const res = await request(path, { method: "DELETE" });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(data.error || `Request failed: ${res.status}`);
    }
  }

  return {
    get,
    post,
    put,
    patch,
    del,
    fetch: request,
    baseUrl,
    setToken(t) {
      token = t;
    },
  };
}
