// Service worker proxy for remote daemon connections.
// In remote mode, intercepts /api/* and /ext/* requests, rewrites URLs to the
// daemon origin, and injects Bearer auth headers. In local mode (no config),
// passes everything through unchanged.

/** @type {{ daemonUrl: string; token: string } | null} */
let config = null;

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "configure") {
    config = event.data.daemonUrl
      ? { daemonUrl: event.data.daemonUrl.replace(/\/$/, ""), token: event.data.token }
      : null;
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
