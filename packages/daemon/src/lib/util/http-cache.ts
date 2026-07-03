import type { Stats } from "node:fs";
import type { Context } from "hono";

/** Weak ETag derived from file mtime + size. */
export function fileEtag(stat: Stats): string {
  return `W/"${stat.mtimeMs.toString(36)}-${stat.size.toString(36)}"`;
}

/** True when the request's If-None-Match matches the given ETag. */
export function isNotModified(c: Context, etag: string): boolean {
  const inm = c.req.header("if-none-match");
  if (!inm) return false;
  return inm.split(",").some((t) => t.trim() === etag);
}
