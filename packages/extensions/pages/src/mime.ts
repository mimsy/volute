/**
 * Content types for the files a page is made of.
 *
 * Shared by the two servers that hand a mind's pages to a browser — the public
 * site route and the loopback origin a preview renders from — because the preview
 * exists to show what the published page will look like, and it cannot do that if
 * the same stylesheet arrives as a different type in each.
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
