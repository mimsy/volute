// Service worker proxy for remote daemon connections.
// In remote mode, intercepts /api/* and /ext/* requests, rewrites URLs to the
// daemon origin, and injects Bearer auth headers. In local mode (no config),
// passes everything through unchanged.

/** @type {{ daemonUrl: string; token: string } | null} */
let config = null;

// Persist config to IndexedDB so it survives SW restarts
const DB_NAME = "volute-sw";
const STORE_NAME = "config";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE_NAME);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveConfig(cfg) {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE_NAME, "readwrite");
    if (cfg) {
      tx.objectStore(STORE_NAME).put(cfg, "current");
    } else {
      tx.objectStore(STORE_NAME).delete("current");
    }
    db.close();
  } catch {
    // Best effort — SW still works with in-memory config
  }
}

async function loadConfig() {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).get("current");
    return new Promise((resolve) => {
      req.onsuccess = () => {
        db.close();
        resolve(req.result || null);
      };
      req.onerror = () => {
        db.close();
        resolve(null);
      };
    });
  } catch {
    return null;
  }
}

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    loadConfig().then((saved) => {
      if (saved) config = saved;
      return self.clients.claim();
    }),
  );
});

self.addEventListener("message", (event) => {
  // Only accept configuration from window clients (not iframes or other SWs)
  if (!event.source || event.source.type !== "window") return;

  if (event.data?.type === "configure") {
    config = event.data.daemonUrl
      ? { daemonUrl: event.data.daemonUrl.replace(/\/$/, ""), token: event.data.token }
      : null;
    saveConfig(config);
  }
});

self.addEventListener("fetch", (event) => {
  if (!config) return;

  const url = new URL(event.request.url);

  // Only proxy /api/ and /ext/ paths
  if (!url.pathname.startsWith("/api/") && !url.pathname.startsWith("/ext/")) return;

  const targetUrl = config.daemonUrl + url.pathname + url.search;
  const headers = new Headers(event.request.headers);
  if (config.token) {
    headers.set("Authorization", `Bearer ${config.token}`);
  }

  const init = {
    method: event.request.method,
    headers,
    mode: "cors",
    credentials: "omit",
  };

  // Only attach body for non-GET/HEAD requests
  if (event.request.method !== "GET" && event.request.method !== "HEAD") {
    init.body = event.request.body;
    init.duplex = "half";
  }

  event.respondWith(fetch(targetUrl, init));
});
