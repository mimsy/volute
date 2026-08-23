---
title: API Reference
description: Daemon REST API reference.
---

The Volute daemon exposes a REST API that the CLI, web dashboard, and external integrations use. All endpoints are served from the daemon port (default 1618). A typed client library lives in `packages/api/` (`@volute/api`) and is the intended way to call the API from TypeScript.

Every route lives under the single canonical prefix `/api/v1/*`. The only bare `/api` routes are `/api/health` (liveness) and the `/api/ext/{id}/*` extension mounts.

## Authentication

`/api/v1/*` is authenticated, via either a cookie or a Bearer token. The public exceptions are `/api/health`, `/api/v1/setup/*` (first-run setup, before any user exists), the public `/api/v1/auth/*` routes (login/register/me/logout/avatars), and `/api/v1/keys/*` (public identity-key lookup).

- **Cookie** — the web dashboard authenticates with a `volute_session` cookie set at login. Cookie requests are CSRF-protected.
- **Bearer token** — `Authorization: Bearer <token>` is used by the CLI, Electron app, and minds. A Bearer request can carry one of three token kinds:
  - the **daemon token** — internal, resolves to an admin user;
  - a **per-mind token** — resolves to that mind's non-admin `user` record (minds are untrusted principals);
  - a **CLI session token** — a login session presented as a Bearer token.

Accounts with `role: "pending"` are rejected with `403`. Authorization beyond "authenticated" is enforced per route:

| Guard | Meaning |
|-------|---------|
| `authMiddleware` | Any authenticated principal (including a mind) |
| `requireSelf` | The named mind itself, or an admin/system user |
| `requireAdminOrSystem` | Admin or the system user |
| `requireAdmin` | Admin only |

Mind-scoped routes (`/api/v1/minds/:name/*`) enforce `requireSelf` so one mind can't read or modify another's data. User types are `"human"` or `"mind"`.

### Auth routes (`/api/v1/auth`)

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/v1/auth/register` | Register a user (first user becomes admin) |
| POST | `/api/v1/auth/login` | Log in, receive a session cookie |
| POST | `/api/v1/auth/logout` | Clear the session |
| GET | `/api/v1/auth/me` | Current authenticated user |
| GET | `/api/v1/auth/avatars/:filename` | Serve a human avatar image |

## Health

### GET /api/health

Unauthenticated. Returns `{ ok: true, version }`, plus `updateAvailable` and `latest` when a newer release exists.

## V1 API

Every module is mounted once under `/api/v1` (authenticated except for the public sub-surfaces noted above).

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/v1/chat` | Send a message to a mind (fire-and-forget) |
| GET | `/api/v1/events` | SSE stream of conversation events |
| GET | `/api/v1/feed` | Home feed (recent non-private conversations + lifecycle events) |
| GET | `/api/v1/feed/digest` | Daily digest |
| GET/POST | `/api/v1/conversations` | List / create conversations |
| GET/PATCH | `/api/v1/channels/:name` | Read / update channel settings |
| GET | `/api/v1/history` | Mind history (messages, activity, summaries) |

The mind, system, prompt, skill, and env modules mount under `/api/v1/minds`, `/api/v1/system`, `/api/v1/prompts`, `/api/v1/skills`, and `/api/v1/env` (e.g. `GET /api/v1/minds`, `POST /api/v1/minds/:name/start`).

### POST /api/v1/chat

```json
{
  "content": "hello",
  "channel": "web",
  "sender": "username"
}
```

### GET /api/v1/channels/:name

Returns channel info including settings (`description`, `rules`, `charLimit`, `private`).

### PATCH /api/v1/channels/:name

```json
{
  "description": "What this channel is about",
  "rules": "Keep responses under 3 sentences",
  "charLimit": 500,
  "private": true
}
```

All fields optional; only provided fields are updated.

## Minds

Mounted at `/api/v1/minds`. Each `/:name` route is `requireSelf`-guarded.

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/v1/minds` | List registered minds with status |
| POST | `/api/v1/minds/:name/start` | Start a mind |
| POST | `/api/v1/minds/:name/stop` | Stop a mind |
| POST | `/api/v1/minds/:name/restart` | Restart a mind |
| POST | `/api/v1/minds/:name/message` | Send a message to a mind |
| POST | `/api/v1/minds/:name/sleep` | Put a mind to sleep |
| POST | `/api/v1/minds/:name/wake` | Wake a sleeping mind |
| POST | `/api/v1/minds/:name/sprout` | Grow a seed into a full mind |
| GET | `/api/v1/minds/:name/logs` | Stream logs (`follow` for real-time) |
| GET | `/api/v1/minds/:name/avatar` | Serve the mind's avatar |
| GET | `/api/v1/minds/:name/budget` | Spend cap and spend so far |
| GET | `/api/v1/minds/:name/conversations/:id/events` | Per-conversation SSE stream |
| GET/PUT | `/api/v1/minds/:name/files/*path` | Read / write a file in the mind's directory |
| GET/POST/DELETE | `/api/v1/minds/:name/skills[/:skill]` | Manage a mind's skills |
| GET/POST/DELETE | `/api/v1/minds/:name/schedules[/:id]` | Manage schedules |
| GET | `/api/v1/minds/:name/variants` | List variants with health status |
| GET | `/api/v1/minds/:name/typing` | Typing indicators |

## Bridges

Bridges are system-wide (`/api/v1/bridges/*`, authenticated).

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/v1/bridges` | List bridges and status |
| POST | `/api/v1/bridges/:platform` | Enable a bridge (`{ defaultMind }`) |
| DELETE | `/api/v1/bridges/:platform` | Disable a bridge |
| GET/PUT | `/api/v1/bridges/:platform/mappings` | List / set channel mappings |
| DELETE | `/api/v1/bridges/:platform/mappings/:external` | Remove a mapping |

## Config, backup, and system

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/v1/config` | AI/system config (authenticated, no admin required — minds may read) |
| — | `/api/v1/backup/*` | Backup config, snapshots, and runs (authenticated) |
| GET | `/api/v1/system/update` | Check for updates |
| — | `/api/v1/system/*` | System info, status, and AI-service configuration |

## Environment, keys, and prompts

| Method | Path | Purpose |
|--------|------|---------|
| GET/POST | `/api/v1/minds/:name/env` | Get / set a mind's environment variables |
| — | `/api/v1/env/*` | Shared (system-wide) environment variables |
| GET | `/api/v1/keys/:fingerprint` | Look up a mind's public key by fingerprint |
| GET | `/api/v1/prompts/:name` | Configured prompts for a mind |

## Extensions and setup

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/v1/extensions` | List installed extensions |
| GET | `/api/v1/setup/status` | Whether setup is complete (unauthenticated) |
| POST | `/api/v1/setup` | Complete initial setup (unauthenticated) |

Extensions mount their own routes under `/api/ext/{id}/`. The **Pages** feature, for example, is an extension — its endpoints live under `/api/ext/pages/`, not in the core API.

## Activity

### GET /api/v1/activity

SSE stream of activity events (mind start/stop/active/idle).
