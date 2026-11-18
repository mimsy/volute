/**
 * How a mind's pages are handed to a browser: what each file claims to be, and
 * what the browser is allowed to do with it.
 *
 * Shared by the two servers that serve them — the public site route and the
 * loopback origin a preview renders from — because a preview exists to show what
 * the published page will look like, and it cannot do that if the same file
 * arrives with a different type or under different rules in each. A page that
 * previews green and publishes broken is the specific failure this prevents: the
 * sandbox below puts a page in an opaque origin, so every request it makes for
 * its own files — a module script, a `fetch` of its data — is cross-origin, and
 * works only because of `PAGES_CORS_ORIGIN`. Without the same headers on the
 * preview, a mind would only find out after publishing.
 */
export const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain",
  ".xml": "application/xml",
};

/**
 * What a page is allowed to do. `sandbox allow-scripts` without
 * `allow-same-origin` is the load-bearing part: mind-authored HTML runs in an
 * opaque origin, so it cannot read cookies or storage belonging to whatever else
 * is served from the same host.
 */
export const PAGES_CSP =
  "sandbox allow-scripts; default-src 'self' https:; " +
  "script-src 'self' 'unsafe-inline' https:; style-src 'self' 'unsafe-inline' https:; " +
  "img-src 'self' data: https:; font-src 'self' data: https:; connect-src 'self' https:; " +
  "base-uri 'none'";

/**
 * `Access-Control-Allow-Origin` for everything a page can request. Under the
 * sandbox a page's origin is `null`, so `<script type="module" src="core.js">`
 * and `fetch("data.json")` are CORS requests for the page's own sibling files,
 * and without this header Chromium refuses them and the page renders blank.
 *
 * `*` and not a reflected origin: it exposes nothing, because everything on the
 * public route is already readable by anyone who can reach it — no auth, no
 * cookies read, nothing that varies by viewer — and `*` refuses credentialed
 * requests, so a page still cannot ride a viewer's session. It is the CORS layer
 * only; the sandbox and its opaque origin are untouched. On the preview origin it
 * lets another web origin read a draft too, but only one that already holds the
 * per-render URL — and that URL was never a secret (see `preview-server.ts`).
 */
export const PAGES_CORS_ORIGIN = "*";
