import { hc } from "hono/client";
import type { AppType } from "../web/app.js";

export type Client = ReturnType<typeof hc<AppType>>;

let _client: Client | undefined;

/**
 * Get a typed hono client for building type-safe API paths.
 *
 * For endpoints without Zod validators, use `$url()` for path construction
 * and `daemonFetch` for the actual request. For endpoints with validators
 * (e.g. typing), you can call `$get`/`$post` directly on the client.
 *
 * The base URL "http://localhost" is a placeholder since we use `$url()`
 * for path construction only — `daemonFetch` handles the real URL.
 */
export function getClient(): Client {
  _client ??= hc<AppType>("http://localhost");
  return _client;
}

/** Build a type-safe URL path from the client, returning just the pathname + search. */
export function urlOf(url: URL): string {
  return url.pathname + url.search;
}
