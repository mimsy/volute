// Daemon connection state for remote UI mode.
// In local mode (daemon serves the UI), this is unused — daemonUrl is null.
// In remote mode, manages service worker registration and Bearer auth.

const STORAGE_KEY = "volute_connection";

type StoredConnection = { daemonUrl: string; token: string };

function loadStored(): StoredConnection | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed?.daemonUrl && parsed?.token) return parsed;
  } catch {
    // ignore
  }
  return null;
}

function saveStored(conn: StoredConnection | null): void {
  if (conn) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(conn));
  } else {
    localStorage.removeItem(STORAGE_KEY);
  }
}

export const daemon = $state({
  /** Remote daemon URL, or null for local mode */
  daemonUrl: null as string | null,
  /** Bearer token for remote auth */
  token: null as string | null,
  /** Whether we've finished detecting local vs remote */
  detected: false,
  /** Whether the service worker is active */
  swReady: false,
});

/** True when we're in remote mode (daemon URL configured) */
export function isRemote(): boolean {
  return daemon.daemonUrl !== null;
}

/** Check if we can reach a daemon at the current origin */
async function probeLocal(): Promise<boolean> {
  try {
    const res = await fetch("/api/health", { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Check if a remote daemon is reachable */
export async function probeRemote(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url.replace(/\/$/, "")}/api/health`, {
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Login to a remote daemon and get a session token */
export async function remoteLogin(
  daemonUrl: string,
  username: string,
  password: string,
): Promise<{ token: string; user: { id: number; username: string; role: string } }> {
  const url = `${daemonUrl.replace(/\/$/, "")}/api/auth/login`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error || `Login failed: ${res.status}`);
  }
  const data = await res.json();
  return { token: data.sessionId, user: data };
}

/** Configure the service worker with daemon URL and token */
async function configureSW(daemonUrl: string, token: string): Promise<void> {
  const reg = await navigator.serviceWorker.register("/sw.js");

  // Wait for the service worker to be active
  const sw = reg.active ?? reg.installing ?? reg.waiting;
  if (!sw) throw new Error("Service worker failed to install");

  if (sw.state !== "activated") {
    await new Promise<void>((resolve) => {
      sw.addEventListener("statechange", function handler() {
        if (sw.state === "activated") {
          sw.removeEventListener("statechange", handler);
          resolve();
        }
      });
    });
  }

  // Wait for the SW to claim this client (skipWaiting + clients.claim in sw.js)
  const ready = await navigator.serviceWorker.ready;

  // If the SW hasn't claimed us yet, wait for the controllerchange event
  if (!navigator.serviceWorker.controller) {
    await new Promise<void>((resolve) => {
      navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true });
    });
  }

  navigator.serviceWorker.controller!.postMessage({
    type: "configure",
    daemonUrl,
    token,
  });

  // Also post to the registration's active worker as a fallback
  ready.active?.postMessage({ type: "configure", daemonUrl, token });

  daemon.swReady = true;
}

/** Unregister the service worker (switching back to local mode) */
async function unregisterSW(): Promise<void> {
  const registrations = await navigator.serviceWorker.getRegistrations();
  for (const reg of registrations) {
    await reg.unregister();
  }
  daemon.swReady = false;
}

/**
 * Initialize daemon connection detection.
 * Call once on app startup (before checkAuth).
 *
 * Returns true if connection is ready (local or remote with SW active).
 * Returns false if we need to show the connection setup UI.
 */
export async function detectConnection(): Promise<boolean> {
  // Try local daemon first
  if (await probeLocal()) {
    daemon.detected = true;
    return true;
  }

  // No local daemon — check for saved remote connection
  const stored = loadStored();
  if (stored) {
    try {
      await configureSW(stored.daemonUrl, stored.token);
      daemon.daemonUrl = stored.daemonUrl;
      daemon.token = stored.token;
      daemon.detected = true;
      return true;
    } catch {
      // Saved connection failed — clear it and show setup
      saveStored(null);
    }
  }

  daemon.detected = true;
  return false;
}

/** Connect to a remote daemon after successful login */
export async function connectRemote(daemonUrl: string, token: string): Promise<void> {
  const normalized = daemonUrl.replace(/\/$/, "");
  await configureSW(normalized, token);
  daemon.daemonUrl = normalized;
  daemon.token = token;
  saveStored({ daemonUrl: normalized, token });
}

/** Disconnect from remote daemon */
export async function disconnectRemote(): Promise<void> {
  await unregisterSW();
  daemon.daemonUrl = null;
  daemon.token = null;
  saveStored(null);
}
