# Distributed Volute: Separate Daemon, CLI, and Web UI

## Problem

Volute's daemon, web UI, and CLI are coupled to a single machine. You can't run the daemon on a headless server and access the UI from a laptop, or run the CLI remotely.

## Solution

Make the web UI a standalone static artifact that can connect to any daemon. A service worker proxies API and extension requests to the remote daemon, preserving same-origin semantics for extension iframes and postMessage. In local mode (default), nothing changes.

## Architecture

**Local mode (default):** Daemon serves UI + API + extensions on one origin. Cookie auth. Zero config.

**Remote mode:** UI served statically. Service worker intercepts `/api/*` and `/ext/*`, rewrites to daemon URL, injects Bearer auth. Extension iframes stay same-origin to the parent app.

**Future:** Edge proxy (Cloudflare Worker) replaces service worker server-side. UI code unchanged.

## Phases

1. **CORS + conditional CSRF** on daemon (`src/web/app.ts`)
2. **Service worker proxy** (`src/web/ui/public/sw.js`) — URL rewriting + auth injection
3. **Connection UI + state** — daemon URL entry, login, localStorage persistence
4. **Auth verification endpoint** — `GET /api/auth/me`
5. **Move client to `@volute/api`** — configurable `createClient()` function
6. CLI remote support (design only)
7. Electron remote support (design only)

## Key Decisions

- **Service worker for proxy** (not edge proxy) — zero infrastructure, works with static hosting. Edge proxy for cloud later.
- **SSE stays** (not WebSocket) — Cloudflare-friendly, covers all current needs.
- **Token-based auth** for remote — Bearer tokens via `Authorization` header. Auth middleware already supports this.
- **Extension iframes proxied** through service worker to maintain same-origin contract (postMessage, cookies, theme CSS).
