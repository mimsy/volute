/**
 * How a mind's pages are handed to a browser: what each file claims to be, and
 * what the browser is allowed to do with it.
 *
 * Shared by the two servers that serve them — the public site route and the
 * loopback origin a preview renders from — because a preview exists to show what
 * the published page will look like, and it cannot do that if the same file
 * arrives with a different type or under different rules in each. A page that
 * previews green and publishes broken is the specific failure this prevents: the
 * sandbox below puts a page in an opaque origin, where a same-origin `fetch` of
 * its own data file fails. Without these headers on the preview, a mind would
 * only find that out after publishing.
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
